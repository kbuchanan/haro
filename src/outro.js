// Node, AMD & window supported
if (typeof exports !== "undefined") {
	module.exports = factory;
} else if (typeof define === "function") {
	define(function () {
		return factory;
	});
} else {
	global.haro = factory;
}
}(typeof window !== "undefined" ? window : global));
