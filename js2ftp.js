"use strict";

var soef = require('soef'),
    path = require('path'),
    FTPServer = require('ftpd').FtpServer;

// var config = {
//     user: 'root',
//     port: 2221,
//     password: 'fl',
//     useGlobalScriptAsPrefix: true,
//     restartScript: true,
//     disableWrite: false
// };

var server, scripts;

var adapter = soef.Adapter (
    main,
    onStateChange,
    onObjectChange,
    onUnload,
    'js2ftp'
);

function onUnload(callback) {
    if (server) server.close();
    server = null;
    callback && callback();
}

function onStateChange(id, state) {
    var dcs = adapter.idToDCS(id);
}

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

var reScriptJsDot = /^script\.js\./;
var reScriptJs = /^script\.js/;

function onObjectChange(id, object) {
    if (soef.lastIdToModify === id || !reScriptJsDot.test(id)) return;
    var o = scripts.id2obj(id);
    if (o) {
        if (object.common.source === o.value.common.source) return;

        o.value.common = object.common;
        o.mtime = new Date();
        soef.modifyObject(id, { common: { mtime: o.mtime.getTime() }} );
    }
}

function enableScript(id, val, callback) {
    soef.modifyObject(id, { common: { enabled: val } }, callback);
}

function restartScript(id, callback) {
    enableScript(id, false, function (err, obj) {
        if (err) return callback && callback(err);
        setTimeout(function () {
            enableScript(id, true, callback);
        })
    });
}

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

var Scripts = function () {
    if (!(this instanceof Scripts)) {
        return new Scripts ();
    }
    this.globalScript = '';
    var ids = {}, fns = {}, objs = {}, self = this;
    var regExGlobalOld = /_global$/;
    var regExGlobalNew = /script\.js\.global\./;
 
    var checkIsGlobal = function (obj) {
        return regExGlobalOld.test (obj.common.name) || regExGlobalNew.test (obj._id);
    };
    
    this.id2obj = this.id2obj = function (id) {
        return ids[id];
    };
    this.getobj = function (fnOrId) {
        if (typeof fnOrId !== 'string') fnOrId = fnOrId.toString();
        if (fnOrId[0] === '/') fnOrId.replace(/\//g, '\\');
        if (fnOrId[0] === '\\') return fns[fnOrId];
        return ids[fnOrId];
    };
    
    this.read = function (callback) {
        objs = {};
        var scripts = [];
        //globalLineCount = 0;
        this.globalScript = '';
        
        adapter.objects.getObjectList ({ startkey: 'script.js.', endkey: 'script.js.' + '\u9999' }, null, function (err, res) {
            if (err || !res || !res.rows) return;
            res.rows.forEach (function (o) {
                o = o.value;
                if (o.type !== 'script') return;
                
                var oo = {
                    isFile: true,
                    isGlobal: checkIsGlobal (o),
                    value: o,
                    id: o._id,
                    mtime: o.common.mtime ? new Date (o.common.mtime) : 0 //new Date(0);
                };
                scripts.push (oo);

                if (oo.isGlobal && o.common.enabled) {
                    self.globalScript += o.common.source + '\n';
                }
                
                var obj = objs;
                o._id.split ('.').forEach (function (n, i) {
                    if (i < 2) return;
                    obj[n] = obj[n] || {};
                    obj = obj[n];
                });
                obj.isFile = true;
            });
            scripts = scripts.sort (function (a, b) {
                if (a.value._id > b.value._id) return 1;
                if (a.value._id < b.value._id) return -1;
                return 0;
            });
            
            function buildFilename (o) {
                return o.id.replace (reScriptJs, '').replace (/\./g, '\\') + '.js';
            }
            
            function add (o) {
                ids[o.id] = o;
                fns[o.fn] = o;
                // ??????
                // var obj = objs;
                // o.id.split ('.').forEach (function (n, i) {
                //     if (i < 2) return;
                //     obj[n] = obj[n] || {};
                //     obj = obj[n];
                // });
            }
            
            scripts.forEach (function (o, i) {
                var id, path;
                id = o.value._id.replace (/(.*)\..*?$/, '$1');
                o.fn = o.fn || buildFilename (o); //o.value._id.replace(reScriptJs, '').replace(/\./g, '\\') + '.js';
                path = id.replace (reScriptJs, '').replace (/\./g, '\\') || '\\';
                add (o);
                if (ids[id] === undefined) {
                    var newo = {id: id, fn: path, isFile: false, dirs: []};
                    add (newo);
                    var oo = soef.getProp (objs, id.replace (reScriptJsDot, '')) || objs;
                    if (oo) Object.getOwnPropertyNames (oo).forEach (function (n) {
                        newo.dirs.push ('\\' + n + (oo[n].isFile === true ? '.js' : ''));
                    });
                }
            });
            
            self.globalScriptMagic = '/*** CD3D5AC4-9831-4ECA-828F-17C369C592B5 ***/';
            var reGlobalScriptMagic = /^[\s|\S]*CD3D5AC4-9831-4ECA-828F-17C369C592B5.*?\r?\n([\s|\S]*)/;
            self.globalScript = self.globalScript.slice(0, -1) + self.globalScriptMagic + '\n';
            
            self.removeGlobalScript = function (source) {
                if (!adapter.config.useGlobalScriptAsPrefix) return source;
                var ar = reGlobalScriptMagic.exec(source);
                if (!ar || ar.length < 2) return false;
                return ar[1];
            };
            callback && callback ();
        });
    };
};

var startServer = function () {
    
    var ip = require ('ip');
    var address = ip.address ();
    var server = new FTPServer (address, {
        getInitialCwd: function () {
            return '';
        },
        getRoot: function () {
            return '';
        },
        useWriteFile: true,
        useReadFile: true,
        //rootPath: '/script.js',
        //initialCwd: '/script.js',
        //users: [],
        allowAnonymous: false
    });
    
    server.on ('client:connected', function (connection) {
        var handler = {};
        var remoteClient = connection.socket.remoteAddress + ':' + connection.socket.remotePort, usr = '';
        
        connection.on ('command:user', function (user, success, failure) {
            if (!user || user !== adapter.config.user) return failure ();
            usr = user;
            remoteClient += ' - ' + usr;
            adapter.log.info('remoteClient: ' + remoteClient);
            success ();
        });
    
        connection.on ('command:pass', function (pass, success, failure) {
            if (!pass || pass !== adapter.config.password) return failure ();
            success (usr, handler);
        });
    
        function getScriptObj(path, callback) {
            if (path === undefined) {
                callback && callback(new Error('invalid path'), []);
                return false;
            }
            var o = scripts.getobj(path);
            if (!o) {
                var re = /^[\\|\/]([0-9]{4})([0-9]{2})([0-9]{2})([0-9]{2})([0-9]{2})([0-9]{2}) (.*)/;
                var ar = re.exec(path);
                if (ar && ar.length >= 7) {
                    path = '\\' + ar.pop();
                    o = scripts.getobj(path);
                    if (o) {
                        // timesamp
                        for (var i = 1; i < ar.length; i++) ar[i] = ~~ar[i];
                        //return ({ mtime: new Date(ar[1], ar[2]-1, ar[3], ar[4], ar[5], ar[6]) });
                        o.mtime = new Date (ar[1], ar[2] - 1, ar[3], ar[4], ar[5], ar[6]);
                        return o;
                    }
                }
                callback && callback(new Error('invalid path'), []);
                return false;
            }
            return o;
        }
        
        var ourHandler = {
            stat: function (obj, callback) {
                var ret = {
                    mode: 511, //0o0777,
                    isDirectory: function () {
                        return !obj.isFile;
                    },
                    isFile: function () {
                        return !!obj.isFile;
                    },
                    size: 1,
                    mtime: obj.mtime || 0
                    //ctime:
                    //atime:
                };
                if (obj.isFile) {
                    ret.size = obj.value.common.source.length;
                }
                callback (null, ret);
            },
            readdir: function (obj, callback) {
                callback (null, obj.dirs);
            },
            readFile: function(obj, callback) {
                callback(null, (adapter.config.useGlobalScriptAsPrefix && !obj.isGlobal ? scripts.globalScript : '') + obj.value.common.source);
            },
            writeFile: function (obj, file, /*options,*/ callback) {
                if (adapter.config.disableWrite) return callback && callback (new Error('EACCES, permission denied'));
                if (!obj.value /*|| !obj.value._id*/) return callback && callback (new Error ('not found'));
                var source = file.toString ();
                var oldEnabled, id = obj.id;
    
                if (!obj.isGlobal || !adapter.config.useGlobalScriptAsPrefix) {
                    source = scripts.removeGlobalScript (source);
                    if (source === false) return callback && callback (new Error ('missing global script prefix'));
                }
                
                soef.modifyObject(id, function(o) {
                    o.common.source = source;
                    obj.value.common.source = source;
                    o.common.mtime = new Date().getTime();
                    if (adapter.config.restartScript) {
                        o.common.enabled = false;
                        oldEnabled = o.common.enabled;
                    }
                }, function (err, o) {
                    if (!oldEnabled) callback && callback(null);
                    enableScript(id, true, function (err, o) {
                        callback && callback(null);
                    })
                });
            }
            
        };
        
        var pathFunctions = 'stat, readdir, readFile, writeFile, !unlink, !rename, !mkdir, !rmdir, !open, !close'.split(', ');
        pathFunctions.forEach(function (name) {
            if (name [0] === '!') {
                handler[name.substr(1)] = function (path) {
                    var error = new Error('EACCES, permission denied');
                    error.code = 'EACCES';
                    arguments[arguments.length - 1] (error);
                };
                return;
            }
            handler[name] = function (path) {
                var callback = arguments[arguments.length-1];
                var obj = getScriptObj(path, callback);
                if (!obj) return;
                adapter.log.info(name + ': path = ' + path);
                arguments[0] = obj;
                ourHandler[name].apply(obj, arguments);
            }
        });

        connection._onClose = function () {
            adapter.log.info ('Client disconnected: ' + remoteClient);
        };
        connection.on ('error', function (error) {
            adapter.log.error ('remoteClient %s had an error: %s', remoteClient, error.toString ());
        });
    });

    server.listen (adapter.config.port);
};

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

function normalizeConfig(config) {
    if (config.port === undefined) config.port = 21;
    if (config.useGlobalScriptAsPrefix === undefined) config.useGlobalScriptAsPrefix = true;
    if (config.restartScript === undefined) config.restartScript = true;
    if (config.disableWrite === undefined) config.disableWrite = false;
}


function main() {
    
    normalizeConsig(adapter.config);

    scripts = Scripts();
    scripts.read(function () {
        startServer();
    });

    //normalizeConfig();
    
    adapter.subscribeStates('*');
    //adapter.subscribeObjects('*');
    adapter.subscribeForeignObjects('*');
}

