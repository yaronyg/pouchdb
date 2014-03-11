/*globals cordova */
"use strict";

var Adapter = require('./adapter');
var utils = require('./utils');
var Promise = typeof global.Promise === 'function' ? global.Promise : require('bluebird');
var TaskQueue = require('./taskqueue');

function defaultCallback(err) {
  if (err && global.debug) {
    console.error(err);
  }
}
utils.inherits(PouchDB, Adapter);
function PouchDB(name, opts, callback) {

  if (!(this instanceof PouchDB)) {
    return new PouchDB(name, opts, callback);
  }
  var self = this;
  if (typeof opts === 'function' || typeof opts === 'undefined') {
    callback = opts;
    opts = {};
  }

  if (typeof name === 'object') {
    opts = name;
    name = undefined;
  }
  if (typeof callback === 'undefined') {
    callback = defaultCallback;
  }
  opts = opts || {};
  var oldCB = callback;
  self.auto_compaction = opts.auto_compaction;
  self.prefix = PouchDB.prefix;
  Adapter.call(self);
  self.taskqueue = new TaskQueue();
  var promise = new Promise(function (fulfill, reject) {
    callback = function (err, resp) {
      if (err) {
        return reject(err);
      }
      delete resp.then;
      fulfill(resp);
    };
  
    opts = utils.extend(true, {}, opts);
    var originalName = opts.name || name;
    var backend, error;
    (function () {
      try {

        if (typeof originalName !== 'string') {
          error = new Error('Missing/invalid DB name');
          error.code = 400;
          throw error;
        }

        backend = PouchDB.parseAdapter(originalName);
        
        opts.originalName = originalName;
        opts.name = backend.name;
        opts.adapter = opts.adapter || backend.adapter;

        if (!PouchDB.adapters[opts.adapter]) {
          error = new Error('Adapter is missing');
          error.code = 404;
          throw error;
        }

        if (!PouchDB.adapters[opts.adapter].valid()) {
          error = new Error('Invalid Adapter');
          error.code = 404;
          throw error;
        }
      } catch (err) {
        self.taskqueue.fail(err);
        self.changes = utils.toPromise(function (opts) {
          if (opts.complete) {
            opts.complete(err);
          }
        });
      }
    }());
    if (error) {
      return reject(error); // constructor error, see above
    }
    self.adapter = opts.adapter;
    // needs access to PouchDB;
    self.replicate = utils.getArguments(function (args) {
      var promise;
      if (args.length === 2 && Array.isArray(args[0])) {
        promise = args[1];
        args = args[0];
      }
      var src = args[0];
      var target = args[1];
      var callback, opts;
      if (typeof args[2] === 'function') {
        callback = args[2];
        opts = {};
      } else {
        opts = args[2];
        callback = args[3];
      }
      opts = opts ? utils.extend(true, {}, opts) : {};
      callback = callback || function () {};
      var self = this;
      var result;
      // If promise is defined, this is being recalled via the taskqueue
      if (promise) {
        // changes may have been cancelled between being queued
        if (promise.isCancelled) {
          callback(null, {status: 'cancelled'});
        } else {
          result = PouchDB.replicate(src, target, opts, callback);
          promise.cancel = function (a) {
            result.cancel(a);
          };
        }
        return;
      }
      var complete = utils.once(callback);
      promise = new Promise(function (fulfill, reject) {
        callback = function (err, res) {
          if (err) {
            reject(err);
          } else {
            fulfill(res);
          }
        };
      });

      promise.then(function (result) {
        complete(null, result);
      }, function (err) {
        complete(err);
      });
      promise.cancel = function () {
        promise.isCancelled = true;
        if (self.taskqueue.isReady) {
          complete(null, {status: 'cancelled'});
        }
      };
      var newPromise;
      if (!this.taskqueue.isReady) {
        this.taskqueue.addTask('replicate', [[src, target, opts, callback], promise]);
        return promise;
      } else {
        newPromise = PouchDB.replicate(src, target, opts, callback);
        promise.cancel = newPromise.cancel.bind(newPromise);
        return promise;
      }
    });

    self.replicate.from = function (url, opts, callback) {
      if (typeof opts === 'function') {
        callback = opts;
        opts = {};
      }
      return self.replicate(url, self, opts, callback);
    };

    self.replicate.to = function (dbName, opts, callback) {
      if (typeof opts === 'function') {
        callback = opts;
        opts = {};
      }
      return self.replicate(self, dbName, opts, callback);
    };

    self.replicate.sync = function (dbName, opts, callback) {
      if (typeof opts === 'function') {
        callback = opts;
        opts = {};
      }
      return PouchDB.sync(self, dbName, opts, callback);
    };
    self.destroy = utils.adapterFun('destroy', function (callback) {
      var self = this;
      self.info(function (err, info) {
        if (err) {
          return callback(err);
        }
        PouchDB.destroy(info.db_name, callback);
      });
    });
    PouchDB.adapters[opts.adapter].call(self, opts, function (err, db) {
      if (err) {
        if (callback) {
          self.taskqueue.fail(err);
          callback(err);
        }
        return;
      }
      function destructionListner(event) {
        if (event === 'destroyed') {
          self.emit('destroyed');
          PouchDB.removeListener(opts.name, destructionListner);
        }
      }
      PouchDB.on(opts.name, destructionListner);
      self.emit('created', self);
      PouchDB.emit('created', opts.originalName);
      self.taskqueue.ready(self);
      callback(null, self);
      
    });
    if (opts.skipSetup) {
      self.taskqueue.ready(self);
    }

    if (utils.isCordova()) {
      //to inform websql adapter that we can use api
      cordova.fireWindowEvent(opts.name + "_pouch", {});
    }
  });
  promise.then(function (resp) {
    oldCB(null, resp);
  }, oldCB);
  self.then = promise.then.bind(promise);
  //prevent deoptimizing
  (function () {
    try {
      self['catch'] = promise['catch'].bind(promise);
    } catch (e) {}
  }());
}

module.exports = PouchDB;
