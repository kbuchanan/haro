	class Haro {
		constructor (data, config = {}) {
			this.adapters = {};
			this.data = new Map();
			this.delimiter = "|";
			this.config = {
				method: "get",
				credentials: false,
				headers: {
					accept: "application/json",
					"content-type": "application/json"
				}
			};
			this.id = uuid();
			this.index = [];
			this.indexes = new Map();
			this.key = "";
			this.loading = false;
			this.logging = true;
			this.patch = false;
			this.pattern = "\\s*|\\t*";
			this.registry = [];
			this.source = "";
			this.total = 0;
			this.uri = "";
			this.worker = null;
			this.versions = new Map();
			this.versioning = true;

			each(Object.keys(config), i => {
				this[i] = merge(this[i], config[i]);
			});

			this.reindex();

			if (data) {
				this.batch(data, "set");
			}
		}

		batch (args, type, lload = false) {
			const defer = deferred(),
				del = type === "del";

			let data, fn, hash;

			function next () {
				Promise.all(args.map(fn)).then(defer.resolve, defer.reject);
			}

			this.loading = true;

			if (del) {
				fn = i => {
					return this.del(i, true);
				};
			} else {
				fn = i => {
					return this.set(null, i, true, true, lload);
				};
			}

			if (this.patch) {
				if (del) {
					data = patch(this.limit(0, this.total, true).map(i => {
						return i[this.key];
					}), args, this.key, true);
				} else {
					data = [];
					hash = {};
					each(args, i => {
						let key = i[this.key];

						if (key) {
							hash[key] = i;
						} else {
							data.push({op: "add", path: "/", value: i});
						}
					});
					data = data.concat(patch(this.toObject(undefined, false), hash, this.key, true));
				}

				if (data.length > 0) {
					this.request(concatURI(this.uri, null), {
						method: "patch",
						body: JSON.stringify(data)
					}).then(next, defer.reject);
				} else {
					defer.resolve();
				}
			} else {
				next();
			}

			return defer.promise.then(arg => {
				const larg = tuple.apply(tuple, arg);

				this.loading = false;
				this.onbatch(type, larg);

				if (this.logging) {
					console.log("Batch inserted data into", this.id);
				}

				return larg;
			}, e => {
				this.loading = false;
				this.onerror("batch", e);
				throw e;
			});
		}

		clear () {
			this.total = 0;
			this.registry.length = 0;
			this.data.clear();
			this.indexes.clear();
			this.versions.clear();
			this.reindex().onclear();

			if (this.logging) {
				console.log("Cleared", this.id);
			}

			return this;
		}

		cmd (type, ...args) {
			const defer = deferred();

			if (!this.adapters[type] || !adapter[type]) {
				defer.reject(new Error(type + " not configured for persistent storage"));
			} else {
				adapter[type].apply(this, [this].concat(args)).then(defer.resolve, defer.reject);
			}

			return defer.promise;
		}

		crawl (arg) {
			let result = clone(arg);

			each((this.source || "").split("."), i => {
				result = result[i];
			});

			return result;
		}

		del (key, batch = false) {
			const defer = deferred();

			let next = () => {
				const index = this.registry.indexOf(key);

				if (index > -1) {
					if (index === 0) {
						this.registry.shift();
					} else if (index === this.registry.length - 1) {
						this.registry.pop();
					} else {
						this.registry.splice(index, 1);
					}

					delIndex(this.index, this.indexes, this.delimiter, key, this.data.get(key), this.pattern);
					this.data.delete(key);
					--this.total;

					if (this.versioning) {
						this.versions.delete(key);
					}

					this.storage("remove", key).then(success => {
						if (success && this.logging) {
							console.log("Deleted", key, "from persistent storage");
						}
					}, e => {
						if (this.logging) {
							console.error("Error deleting", key, "from persistent storage:", e.message || e.stack || e);
						}
					});
				}

				defer.resolve(key);
			};

			if (this.data.has(key)) {
				if (!batch) {
					this.loading = true;
				}

				if (!batch && this.uri) {
					if (this.patch) {
						this.request(concatURI(this.uri, null), {
							method: "patch",
							body: JSON.stringify([{op: "remove", path: "/" + key}])
						}).then(next, e => {
							if (e[1] === 405) {
								this.patch = false;
								this.request(concatURI(this.uri, key), {
									method: "delete"
								}).then(next, defer.reject);
							} else {
								defer.reject(e);
							}
						});
					} else {
						this.request(concatURI(this.uri, key), {
							method: "delete"
						}).then(next, defer.reject);
					}
				} else {
					next();
				}
			} else {
				defer.reject(new Error("Record not found"));
			}

			return defer.promise.then(arg => {
				if (!batch) {
					this.loading = false;
				}

				this.ondelete(arg);

				return arg;
			}, e => {
				if (!batch) {
					this.loading = false;
				}

				this.onerror("delete", e);
				throw e;
			});
		}

		dump (type = "records") {
			let result;

			if (type === "records") {
				result = this.toArray(null, false);
			} else {
				result = this.transform(this.indexes);
			}

			return result;
		}

		entries () {
			return this.data.entries();
		}

		find (where, raw = false) {
			const key = Object.keys(where).sort().join(this.delimiter),
				value = keyIndex(key, where, this.delimiter),
				result = [];

			if (this.indexes.has(key)) {
				(this.indexes.get(key).get(value) || new Set()).forEach(i => {
					result.push(this.get(i, raw));
				});
			}

			return output(result, raw);
		}

		filter (fn, raw = false) {
			const result = [];

			this.forEach((function () {
				if (!raw) {
					return (value, key) => {
						if (fn(value, key) === true) {
							result.push(tuple(key, value));
						}
					};
				} else {
					return (value, key) => {
						if (fn(value, key) === true) {
							result.push(value);
						}
					};
				}
			}()));

			return output(result, raw);
		}

		forEach (fn, ctx) {
			this.data.forEach((value, key) => {
				fn(clone(value), clone(key));
			}, ctx);

			return this;
		}

		get (key, raw = false) {
			const result = clone(this.data.get(key) || null);

			return result && !raw ? tuple(key, result) : result;
		}

		has (key) {
			return this.data.has(key);
		}

		join (other, on = this.key, type = "inner", where = []) {
			const defer = deferred();

			let promise;

			if (other.total > 0) {
				if (where.length > 0) {
					promise = this.offload([[this.id, other.id], this.find(where[0], true), !where[1] ? other.toArray(null, true) : other.find(where[1], true), this.key, on, type], "join");
				} else {
					promise = this.offload([[this.id, other.id], this.toArray(null, true), other.toArray(null, true), this.key, on, type], "join");
				}

				promise.then(arg => {
					if (typeof arg === "string") {
						defer.reject(new Error(arg));
					} else {
						defer.resolve(arg);
					}
				}, defer.reject);
			} else {
				defer.resolve([]);
			}

			return defer.promise;
		}

		keys () {
			return this.data.keys();
		}

		limit (offset = 0, max = 0, raw = false) {
			return output(this.registry.slice(offset, offset + max).map(i => {
				return this.get(i, raw);
			}), raw);
		}

		load (type = "mongo", key = undefined) {
			const batch = key === undefined,
				id = !batch ? key : this.id;

			if (batch) {
				this.clear();
			}

			return this.cmd(type, "get", key).then(arg => {
				if (this.logging) {
					console.log("Loaded", id, "from", type, "persistent storage");
				}

				return batch ? this.batch(arg, "set", true) : this.set(key, arg, true, true, true);
			}, e => {
				if (this.logging) {
					console.error("Error loading", id, "from", type, "persistent storage:", e.message || e.stack || e);
				}

				throw e;
			});
		}

		map (fn, raw = false) {
			const result = [];

			this.forEach((value, key) => {
				result.push(fn(value, key));
			});

			return output(result, raw);
		}

		offload (data, cmd = "index", index = this.index) {
			const defer = deferred();

			let payload, obj;

			if (this.worker) {
				obj = this.useWorker(defer);

				if (obj) {
					if (cmd === "index") {
						payload = {
							cmd: cmd,
							index: index,
							records: data,
							key: this.key,
							delimiter: this.delimiter,
							pattern: this.pattern
						};
					}

					if (cmd === "join") {
						payload = {
							cmd: cmd,
							ids: data[0],
							records: [data[1], data[2]],
							key: data[3],
							on: data[4],
							type: data[5]
						};
					}

					obj.postMessage(JSON.stringify(payload));
				}
			} else {
				defer.reject(new Error(webWorkerError));
			}

			return defer.promise;
		}

		onbatch () {}

		onclear () {}

		ondelete () {}

		onerror () {}

		onrequest (arg) {
			return arg;
		}

		onset () {}

		onsync () {}

		override (data, type = "records", fn = undefined) {
			const defer = deferred();

			if (type === "indexes") {
				this.indexes = this.transform(data, fn);
				defer.resolve(true);
			} else if (type === "records") {
				this.data.clear();
				this.indexes.clear();
				this.registry.length = 0;

				data.forEach(datum => {
					const key = datum[this.key] || uuid();

					this.data.set(key, datum);
					this.registry.push(key);
				});

				this.total = this.data.size;
				defer.resolve(true);
			} else {
				defer.reject(new Error("Invalid type"));
			}

			return defer.promise;
		}

		register (key, fn) {
			adapter[key] = fn;

			return this;
		}

		reindex (index) {
			if (!index) {
				this.indexes.clear();
				this.index.forEach(i => {
					this.indexes.set(i, new Map());
				});
				this.forEach((data, key) => {
					this.index.forEach(i => {
						setIndex(this.index, this.indexes, this.delimiter, key, data, i, this.pattern);
					});
				});
			} else {
				if (this.index.indexOf(index) === -1) {
					this.index.push(index);
				}

				this.indexes.set(index, new Map());
				this.forEach((data, key) => {
					setIndex(this.index, this.indexes, this.delimiter, key, data, index, this.pattern);
				});
			}

			return this;
		}

		request (input, config = {}) {
			const defer = deferred(),
				cfg = merge(clone(this.config), config);

			cfg.method = cfg.method.toUpperCase();

			fetch(input, cfg).then(res => {
				let status = res.status,
					headers;

				if (res.headers._headers) {
					headers = {};
					each(Object.keys(res.headers._headers), i => {
						headers[i] = res.headers._headers[i].join(", ");
					});
				} else {
					headers = toObjekt(res.headers);
				}

				res[res.headers.get("content-type").indexOf("application/json") > -1 ? "json" : "text"]().then(arg => {
					defer[status < 200 || status >= 400 ? "reject" : "resolve"](tuple(this.onrequest(arg, status, headers), status, headers));
				}, e => {
					defer.reject(tuple(e.message, status, headers));
				});
			}, e => {
				defer.reject(tuple(e.message, 0, {}));
			});

			return defer.promise;
		}

		save (type = "mongo") {
			return this.cmd(type, "set").then(arg => {
				if (this.logging) {
					console.log("Saved", this.id, "to", type, "persistent storage");
				}

				return arg;
			}, e => {
				if (this.logging) {
					console.error("Error saving ", this.id, "to", type, "persistent storage:", e.message || e.stack || e);
				}

				throw e;
			});
		}

		search (value, index, raw = false) {
			const result = [],
				fn = typeof value === "function",
				rgex = value && typeof value.test === "function",
				seen = new Set();

			let indexes;

			if (value) {
				if (index) {
					indexes = Array.isArray(index) ? index : [index];
				} else {
					indexes = this.index;
				}

				indexes.forEach(i => {
					let idx = this.indexes.get(i);

					if (idx) {
						idx.forEach((lset, lkey) => {
							switch (true) {
								case fn && value(lkey, i):
								case rgex && value.test(Array.isArray(lkey) ? lkey.join(", ") : lkey):
								case lkey === value:
									lset.forEach(key => {
										if (!seen.has(key)) {
											seen.add(key);
											result.push(this.get(key, raw));
										}
									});
									break;
								default:
									void 0;
							}
						});
					}
				});
			}

			return output(result, raw);
		}

		set (key, data, batch = false, override = false, lload = false) {
			const defer = deferred();

			let method = "post",
				ldata = clone(data),
				lkey = key,
				body, ogdata, luri;

			let next = arg => {
				let xdata = arg ? arg[0] : {};

				if (lkey === null) {
					if (this.key) {
						xdata = this.crawl(xdata);
						lkey = xdata[this.key] || ldata[this.key] || uuid();
					} else {
						lkey = uuid();
					}
				}

				if (method === "post") {
					this.registry[this.total] = lkey;
					++this.total;

					if (this.versioning) {
						this.versions.set(lkey, new Set());
					}
				} else {
					if (this.versioning) {
						this.versions.get(lkey).add(tuple(ogdata));
					}

					delIndex(this.index, this.indexes, this.delimiter, lkey, ogdata, this.pattern);
				}

				this.data.set(lkey, ldata);
				setIndex(this.index, this.indexes, this.delimiter, lkey, ldata, null, this.pattern);
				defer.resolve(this.get(lkey));

				if (!lload) {
					this.storage("set", lkey, ldata).then(success => {
						if (success && this.logging) {
							console.log("Saved", lkey, "to persistent storage");
						}
					}, e => {
						if (this.logging) {
							console.error("Error saving", lkey, "to persistent storage:", e.message || e.stack || e);
						}
					});
				}
			};

			if (lkey === undefined || lkey === null) {
				lkey = ldata[this.key] || null;
			}

			if (lkey && this.data.has(lkey)) {
				method = "put";
				ogdata = clone(this.data.get(lkey) || {});

				if (!override) {
					ldata = merge(ogdata, ldata);
				}
			}

			if (!batch) {
				this.loading = true;
			}

			if (!batch && this.uri) {
				luri = concatURI(this.uri, lkey);

				if (this.patch) {
					if (method === "post") {
						body = [{op: "add", path: "/", value: ldata}];
					} else if (override) {
						body = [{op: "replace", path: "/", value: ldata}];
					} else {
						body = patch(ogdata, ldata, this.key);
					}

					this.request(luri, {
						method: "patch",
						body: JSON.stringify(body, null, 0)
					}).then(next, e => {
						if (e[1] === 405) {
							this.patch = false;
							this.request(luri, {
								method: method,
								body: JSON.stringify(ldata, null, 0)
							}).then(next, defer.reject);
						} else {
							defer.reject(e);
						}
					});
				} else {
					this.request(luri, {
						method: method,
						body: JSON.stringify(ldata)
					}).then(next, defer.reject);
				}
			} else {
				next();
			}

			return defer.promise.then(arg => {
				if (!batch) {
					this.loading = false;
				}

				this.onset(arg);

				return arg;
			}, e => {
				if (!batch) {
					this.loading = false;
				}

				this.onerror("set", e);
				throw e;
			});
		}

		setUri (uri, clear = false) {
			const defer = deferred();

			this.uri = uri;

			if (this.uri) {
				this.sync(clear).then(defer.resolve, defer.reject);
			} else {
				defer.resolve([]);
			}

			return defer.promise;
		}

		sort (fn, frozen = true) {
			let result;

			if (frozen) {
				result = Object.freeze(this.limit(0, this.total, true).sort(fn).map(i => {
					return Object.freeze(i);
				}));
			} else {
				result = this.limit(0, this.total, true).sort(fn);
			}

			return result;
		}

		sortBy (index) {
			const result = [],
				keys = [];

			let lindex;

			if (!this.indexes.has(index)) {
				this.reindex(index);
			}

			lindex = this.indexes.get(index);
			lindex.forEach((idx, key) => {
				keys.push(key);
			});

			each(keys.sort(), i => {
				lindex.get(i).forEach(key => {
					result.push(this.get(key));
				});
			});

			return tuple.apply(tuple, result);
		}

		storage (...args) {
			const defer = deferred(),
				deferreds = Object.keys(this.adapters).map(i => {
					return this.cmd.apply(this, [i].concat(args));
				});

			if (deferreds.length > 0) {
				Promise.all(deferreds).then(() => {
					defer.resolve(true);
				}, defer.reject);
			} else {
				defer.resolve(false);
			}

			return defer.promise;
		}

		sync (clear = false) {
			const defer = deferred();

			let valid = true;

			this.request(this.uri).then(arg => {
				let data;

				this.patch = (arg[2].Allow || arg[2].allow || "").indexOf("PATCH") > -1;

				try {
					data = this.crawl(arg[0]);
				} catch (e) {
					valid = false;
					defer.reject(e);
				}

				if (valid) {
					if (clear) {
						this.clear();
					}

					this.batch(data, "set").then(defer.resolve, defer.reject);
				}
			}, e => {
				defer.reject(e[0] || e);
			});

			return defer.promise.then(arg => {
				const larg = tuple.apply(tuple, arg);

				this.onsync(larg);

				return larg;
			}, e => {
				this.onerror("sync", e);

				throw e;
			});
		}

		toArray (data, frozen = true) {
			let result;

			if (data) {
				result = data.map(i => {
					return frozen ? i[1] : clone(i[1]);
				});
			} else {
				result = this.limit(0, this.total, true);

				if (frozen) {
					each(result, i => {
						Object.freeze(i);
					});
				}
			}

			return frozen ? Object.freeze(result) : result;
		}

		toObject (data, frozen = true) {
			let result;

			result = !data ? toObjekt(this, frozen) : data.reduce((a, b) => {
				const obj = clone(b[1]);

				if (frozen) {
					Object.freeze(obj);
				}

				a[b[0]] = obj;

				return a;
			}, {});

			if (frozen) {
				Object.freeze(result);
			}

			return result;
		}

		transform (input, fn) {
			return typeof fn === "function" ? fn(input) : cast(input);
		}

		unload (type = "mongo", key = undefined) {
			const id = key !== undefined ? key : this.id;

			return this.cmd(type, "remove", key).then(arg => {
				if (this.logging) {
					console.log("Unloaded", id, "from", type, "persistent storage");
				}

				return arg;
			}, e => {
				if (this.logging) {
					console.error("Error unloading", id, "from", type, "persistent storage:", e.message || e.stack || e);
				}

				throw e;
			});
		}

		unregister (key) {
			delete adapter[key];
		}

		values () {
			return this.data.values();
		}

		useWorker (defer) {
			let obj;

			if (this.worker) {
				obj = new Worker(this.worker);
				obj.onerror = err => {
					defer.reject(err);
					obj.terminate();
				};

				obj.onmessage = ev => {
					defer.resolve(JSON.parse(ev.data));
					obj.terminate();
				};
			} else {
				defer.reject(new Error(webWorkerError));
			}

			return obj;
		}
	}
