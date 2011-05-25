var http = require("http");
var https = require("https");
var url = require("url");
var sys = require("sys");
var events = require("events");

// This is a hack to get cookies to work with http library headers. this will likely break any other libraries using node.js/http
// As far as i can see, node.js is broken how it handles headers and this change should be implemented in node.js core
http.IncomingMessage.prototype._addHeaderLine = function (field, value) {
	if(field == "set-cookie") {
		if (this.headers.hasOwnProperty(field)) {
			this.headers[field].push(value);
		} else {
			this.headers[field] = [value];
		}
	}
	else {
		if (this.headers.hasOwnProperty(field)) {
			this.headers[field] += ", " + value;
		} else {
			this.headers[field] = value;
		}
	}
};

try {
	var compress = require("./compress");
}
catch(err) {
	if( err.message.indexOf("Cannot find module") >= 0 ) {
		sys.puts("no compress");
		var compress = null;
	}
	else {
		throw err;
	}
}

function httpclient() {
	var cookies = [];
	
	if( compress !== null ) {
		var gunzip = new compress.Gunzip;
	}
	
	var clients = {
	};

	this.clients = clients;
	
	this.perform = function(rurl, method, cb, data, exheaders, tlscb) {
		this.clientheaders = exheaders;
		var curl = url.parse(rurl);
		var key = curl.protocol + "//" + curl.hostname;
		
		if(!clients[key]) {
			var client_params = null;
			switch(curl.protocol) {
				case "https:":
					client_params = {port: curl.port||443, host: curl.hostname, secure: true};
				break;
				default:
					client_params = {port: curl.port||80, host: curl.hostname };
					break;
			}
			clients[key] = {
				"http": client_params,
				"headers": {}
			};
		}
		
		clients[key].headers = {
			"User-Agent": "Node-Http",
			"Accept" : "*/*",
			"Connection" : "close",
			"Host" : curl.hostname
		};
		if(method == "POST") {
			clients[key].headers["Content-Length"] = data.length;
			clients[key].headers["Content-Type"] = "application/x-www-form-urlencoded";
		}
		for (attr in exheaders) { clients[key].headers[attr] = exheaders[attr]; }		
		if(!compress && clients[key].headers["Accept-Encoding"]) {
			clients[key].headers["Accept-Encoding"] = "none";
		}
		var mycookies = [];

		cookies.filter(function(value, index, arr) {
			if(curl.pathname) {
				return(curl.hostname.substring(curl.hostname.length - value.domain.length) == value.domain && curl.pathname.indexOf(value.path) >= 0);
			}
			else {
				return(curl.hostname.substring(curl.hostname.length - value.domain.length) == value.domain);
			}
		}).forEach( function(cookie) {
			mycookies.push(cookie.value);
		});
		if( mycookies.length > 0 ) {
			clients[key].headers["Cookie"] = mycookies.join(";");
		}
		
		var target = "";
		if(curl.pathname) target += curl.pathname;
		if(curl.search) target += curl.search;
		if(curl.hash) target += curl.hash;
		if(target=="") target = "/";
		
		http_params = clients[key].http
		options = {
	    host: http_params.host,
	    port: http_params.port,
	    path: target,
	    headers: clients[key].headers,
	    method: method,
	  }
	  connection = http_params.secure ? https : http;
		var req = connection.request(options, function (res) {
	    var mybody = [];
			if(tlscb) {
				if(!tlscb({
						"status" : res.connection.verifyPeer(), 
						"certificate" : res.connection.getPeerCertificate("DNstring")
					}
				)) {
					cb(-2, null, null);		
					return;
				}
			}
			res.setEncoding("utf8");
			if(res.headers["content-encoding"] == "gzip") {
				res.setEncoding("binary");
			}
            // allow the caller to force binary encoding for things like JPEG
            if (exheaders !== undefined && exheaders["x-binary"]) {
                res.setEncoding("binary");
            }
			res.addListener("data", function(chunk) {
				mybody.push(chunk);
			});
			res.addListener("end", function() {
				var body = mybody.join("");
				if( compress !== null && res.headers["content-encoding"] == "gzip") {
					gunzip.init();
					body = gunzip.inflate(body, "binary");
					gunzip.end();
				}
				var resp = {
					"response": {
						"status" : res.statusCode,
						"headers" : res.headers,
						"body-length" : body.length,
						"body" : body
					},
					"request": {
						"url" : rurl,
						"headers" : clients[key].headers
					}
				}
				cb(resp);	
			});
			res.addListener("error", function() {
				cb(-1, res.headers, mybody.join(""));		
			});
			if(res.headers["set-cookie"]) {
				res.headers["set-cookie"].forEach( function( cookie ) {
					props = cookie.split(";");
					var newcookie = {
						"value": "",
						"domain": "",
						"path": "/",
						"expires": ""
					};

					newcookie.value = props.shift();
					props.forEach( function( prop ) {
						var parts = prop.split("="),
						name = parts[0].trim();
						switch(name.toLowerCase()) {
							case "domain":
								newcookie.domain = parts[1].trim();
								break;
							case "path":
								newcookie.path = parts[1].trim();
								break;
							case "expires":
								newcookie.expires = parts[1].trim();
								break;
						}
					});
					if(newcookie.domain == "") newcookie.domain = curl.hostname;
					var match = cookies.filter(function(value, index, arr) {
						if(value.domain == newcookie.domain && value.path == newcookie.path && value.value.split("=")[0] == newcookie.value.split("=")[0]) {
							arr[index] = newcookie;
							return true;
						}
						else {
							return false;
						}
					});
					if(match.length == 0) cookies.push(newcookie);
				});
			}
	  });
	  
		req.addListener("response", function(res) {
		});
		
		if(method == "POST") {
			req.write(data);
		}
		req.end();
	}

	this.getCookie = function(domain, name) {
		var mycookies = cookies.filter(function(value, index, arr) {
			return(domain == value.domain);
		});
		for( var i=0; i < mycookies.length; i++ ) {
			parts = mycookies[i].value.split("=");
			if( parts[0] == name ) {
				return parts[1];
			}
		}
		return null;
	}
	
	this.end = function() {
		clients.forEach(function(client) {
			client.http.end();		
		});
	}
}
exports.httpclient = httpclient;
