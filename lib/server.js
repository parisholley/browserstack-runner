var http = require("http"),
  url = require("url"),
  path = require("path"),
  fs = require("fs"),
  qs = require("querystring"),
  utils = require("./utils"),
  config = require('../lib/config'),
  exec = require('child_process').exec,
  chalk = require('chalk');

var mimeTypes = {
  "html": "text/html",
  "json": "text/json",
  "jpeg": "image/jpeg",
  "jpg": "image/jpeg",
  "png": "image/png",
  "js": "text/javascript",
  "css": "text/css"
};


exports.Server = function Server(bsClient, workers) {
  var status = 0;

  function handleFile(filename, request, response) {
    var url_parts = url.parse(request.url, true);
    var query = url_parts.query;

    if (query._worker_key && workers[query._worker_key]) {
      workers[query._worker_key].acknowledged = true;
      console.log("[%s] Acknowledged", query._browser_string);
    }

    fs.exists(filename, function(exists) {
      if (!exists) {
        response.writeHead(404, {
          "Content-Type": "text/plain"
        });
        response.write("404 Not Found\n");
        response.end();
        return;
      }

      if (fs.lstatSync(filename).isDirectory()) {
        filename = filename + (filename.lastIndexOf('/') == filename.length - 1 ? "" : "/") + "index.html";
      }

      fs.readFile(filename, "binary", function(err, file) {

        if (err) {
          response.writeHead(500, {
            "Content-Type": "text/plain"
          });
          response.write(err + "\n");
          response.end();
          return;
        }

        var mimeType = mimeTypes[path.extname(filename).split(".")[1]];
        response.writeHead(200, {
          "Content-Type": mimeType
        });

        scripts = [
          'json2.js',
          'browserstack.js',
        ];

        framework_scripts = {
          'qunit': ['qunit-plugin.js'],
          'jasmine': ['jasmine-jsreporter.js', 'jasmine-plugin.js'],
          'mocha': ['mocha-plugin.js']
        };

        if (mimeType === 'text/html') {
          var matcher = /(.*)<\/head>/;
          var patch = "$1";
          scripts.forEach(function(script) {
            patch += "<script type='text/javascript' src='/_patch/" + script + "'></script>\n";
          });

          // adding framework scripts
          if (config['test_framework'] && config['test_framework'] == "jasmine") {
            framework_scripts['jasmine'].forEach(function(script) {
              patch += "<script type='text/javascript' src='/_patch/" + script + "'></script>\n";
            });
            patch += "<script type='text/javascript'>jasmine.getEnv().addReporter(new jasmine.JSReporter());</script>\n";
          } else if (config['test_framework'] && config['test_framework'] == "mocha") {
            framework_scripts['mocha'].forEach(function(script) {
              patch += "<script type='text/javascript' src='/_patch/" + script + "'></script>\n";
            });
            patch += "<script type='text/javascript'>mocha.reporter(Mocha.BrowserStack);</script>\n";
          } else {
            framework_scripts['qunit'].forEach(function(script) {
              patch += "<script type='text/javascript' src='/_patch/" + script + "'></script>\n";
            });
          }
          patch += "</body>";

          file = file.replace(matcher, patch);
        }


        response.write(file);
        response.end();
      });
    });
  }

  function parseBody(body) {
    // TODO: Have better implementation
    return JSON.parse(qs.parse(body).data.escapeSpecialChars());
  }

  function formatTraceback(details) {
    // looks like QUnit data
    if (details.testName) {
      var output = "'" + details.testName + "' failed";
      if (details.message) {
        output += ", " + details.message;
      }
      if (details.actual && details.expected) {
        output += "\n" + chalk.blue("Expected: ") + details.expected +
          "\n" + chalk.blue("  Actual: ") + details.actual;
      }
      if (details.source) {
        output += "\n" + chalk.blue("  Source: ") + "";
        output += details.source.split("\n").join("\n\t  ");
      }
      return output;
    }
    return details;
  }

  handlers = {
    "_progress": function progressHandler(uri, body, request, response) {
      var uuid = request.headers['x-worker-uuid'];
      var worker = workers[uuid];
      query = "";
      try {
        query = parseBody(body);
      } catch(e) {
        console.log("[%s] Exception in parsing log", worker.string);
        console.log("[%s] Log: " + qs.parse(body).data, worker.string);
      }

      if (query.tracebacks) {
        query.tracebacks.forEach(function(traceback) {
          console.log(chalk.red("[%s] Error:"), worker.string, formatTraceback(traceback));
        });
      }
      response.end();
    },

    "_report": function reportHandler(uri, body, request, response) {
      query = null;
      try {
        query = parseBody(body);
      } catch (e) {}
      var uuid = request.headers['x-worker-uuid'];
      var worker = workers[uuid];

      if (query === null) {
        console.log("[%s] Null response from remote Browser", request.headers['x-browser-string']);
      } else {
        if (query.tracebacks && query.tracebacks.length > 0) {
          console.log("Tracebacks:");
          query.tracebacks.forEach(function(traceback) {
            console.log(traceback);
          });
        }
        var color = query.failed ? "red" : "green";
        console.log(chalk[color]("[%s] Completed in %d milliseconds. %d of %d passed, %d failed."), request.headers['x-browser-string'], query.runtime, query.passed, query.total, query.failed);
        status += query.failed;
      }

      if (worker) {
        bsClient.takeScreenshot(worker.id, function(error, screenshot) {
          if (!error && screenshot.url) {
            console.log('[%s] Screenshot: %s', worker.string, screenshot.url);
          }

          bsClient.terminateWorker(worker.id, function() {
            if (!workers[uuid]) {
              return;
            }

            console.log('[%s] Terminated', worker.string);

            clearTimeout(workers[uuid].activityTimeout);
            delete workers[uuid];

            if (utils.objectSize(workers) === 0) {
              var color = status > 0 ? "red" : "green";
              console.log(chalk[color]("All tests done, failures: %d."), status);

              if (status > 0) {
                status = 1;
              }

              process.exit(status);
            }
          });
        });
      }

      response.end();
    },
    "_log": function logHandler(uri, body, request, response) {
      query = parseBody(body);
      console.log('[' + request.headers['x-browser-string'] + '] ' + query);
      response.end();
    },
    "_patch": function patchHandler(uri, body, request, response) {
      handleFile(path.join(__dirname, uri), request, response);
    },
    "_default": function defaultHandler(uri, body, request, response) {
      handleFile(path.join(process.cwd(), uri), request, response);
    }
  };


  return http.createServer(function(request, response) {
    var uri = url.parse(request.url).pathname;
    var method = uri.split('/')[1];
    var filename;

    var body = '';

    request.on('data', function(data) {
      body += data;
    });
    request.on('end', function() {
      (handlers[method] || handlers._default)(uri, body, request, response);
    });
  });
};
