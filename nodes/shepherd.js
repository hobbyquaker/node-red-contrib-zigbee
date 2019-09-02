const fs = require('fs');
const path = require('path');
const {EventEmitter} = require('events');

const oe = require('obj-ease');
const mkdirp = require('mkdirp');
const Shepherd = require('zigbee-herdsman');
const shepherdConverters = require('zigbee-shepherd-converters');

const interval = require('../interval.json');

const devices = {};
const configured = new Set();
const lights = {};
const shepherdNodes = {};
const shepherdInstances = {};

const {zllDevice, uniqueidSuffix, emptyStates} = require('../zll.js');

module.exports = function (RED) {
    RED.httpAdmin.get('/zigbee-shepherd/hue', (req, res) => {
        res.status(200).send(JSON.stringify(lights[req.query.id] || {}));
    });

    RED.httpAdmin.get('/zigbee-shepherd/devices', (req, res) => {
        res.status(200).send(JSON.stringify(devices[req.query.id] || {}));
    });

    RED.httpAdmin.get('/zigbee-shepherd/scan', (req, res) => {
        if (shepherdNodes[req.query.id]) {
            shepherdNodes[req.query.id].shepherd.lqiScan(shepherdNodes[req.query.id].shepherd.controller._coord.ieeeAddr)
                .then(topology => {
                    res.status(200).json(topology);
                })
                .catch(err => {
                    res.status(500).send('500 Internal Server Error: ' + err.message);
                });
        } else {
            res.status(500).send('500 Internal Server Error: Unknown Shepherd Id');
        }
    });

    RED.httpAdmin.get('/zigbee-shepherd/rtgScan', (req, res) => {
        if (shepherdNodes[req.query.id]) {
            shepherdNodes[req.query.id].rtgScan(result => {
                res.status(200).json(result);
            });
        } else {
            res.status(500).send('500 Internal Server Error: Unknown Shepherd Id');
        }
    });

    RED.httpAdmin.get('/zigbee-shepherd/lqiScan', (req, res) => {
        if (shepherdNodes[req.query.id]) {
            shepherdNodes[req.query.id].lqiScan(result => {
                res.status(200).json(result);
            });
        } else {
            res.status(500).send('500 Internal Server Error: Unknown Shepherd Id');
        }
    });

    RED.httpAdmin.get('/zigbee-shepherd/vis/*', (req, res) => {
        const file = (req.params[0] || '').split('?')[0];
        const root = path.dirname(require.resolve('vis'));
        fs.access(path.join(root, file), fs.constants.F_OK, err => {
            if (err) {
                res.status(404).send('Error 404: file not found');
            } else {
                res.sendFile(file, {
                    root,
                    dotfiles: 'deny'
                });
            }
        });
    });

    RED.httpAdmin.get('/zigbee-shepherd/map/*', (req, res) => {
        const file = (req.params[0] || '').split('?')[0] || 'index.html';
        const root = path.join(__dirname, '../static/map');
        fs.access(path.join(root, file), fs.constants.F_OK, err => {
            if (err) {
                res.status(404).send('Error 404: file not found');
            } else {
                res.sendFile(file, {
                    root,
                    dotfiles: 'deny'
                });
            }
        });
    });

    RED.httpAdmin.post('/zigbee-shepherd/names', (req, res) => {
        if (devices[req.query.id]) {
            Object.keys(req.body).forEach(addr => {
                devices[req.query.id][addr].name = req.body[addr];
            });
            shepherdNodes[req.query.id].save();
        }

        res.status(200).send('');
    });

    RED.httpAdmin.get('/zigbee-shepherd/remove', (req, res) => {
        if (shepherdNodes[req.query.id]) {
            shepherdNodes[req.query.id].remove(req.query.addr);
        }

        res.status(200).send('');
    });

    RED.httpAdmin.get('/zigbee-shepherd/join', (req, res) => {
        if (shepherdNodes[req.query.id]) {
            shepherdNodes[req.query.id].join(parseInt(req.query.time, 10) || 0, req.query.type || 'all');
        }

        res.status(200).send('');
    });

    RED.httpAdmin.post('/zigbee-shepherd/cmd', (req, res) => {
        if (shepherdNodes[req.query.id]) {
            const cmd = JSON.parse(req.body.cmd);
            cmd.callback = (err, result) => {
                if (err) {
                    res.status(500).send(JSON.stringify(err));
                } else {
                    res.status(200).send(JSON.stringify(result));
                }
            };

            shepherdNodes[req.query.id].proxy.queue(cmd);
        }
    });

    RED.httpAdmin.get('/zigbee-shepherd/join-time-left', (req, res) => {
        if (shepherdNodes[req.query.id]) {
            res.status(200).send(JSON.stringify({joinTimeLeft: shepherdNodes[req.query.id].joinTimeLeft}));
        } else {
            res.status(200).send(JSON.stringify({joinTimeLeft: 0}));
        }
    });

    class ShepherdProxy extends EventEmitter {
        constructor(shepherdNode) {
            super();

            this.setMaxListeners(1000);

            this.shepherdNode = shepherdNode;
            this.shepherd = shepherdNode.shepherd;
            this.devices = shepherdNode.devices;
            this.logName = shepherdNode.logName;

            this.queueMaxWait = 5000;
            this.queueMaxLength = 50;
            this.queuePause = 300;
            this.commandQueue = [];

            this.trace = msg => {
                shepherdNode.trace(msg);
            };

            this.debug = msg => {
                shepherdNode.debug(msg);
            };

            this.log = msg => {
                shepherdNode.log(msg);
            };

            this.warn = msg => {
                shepherdNode.warn(msg);
            };

            this.error = msg => {
                shepherdNode.error(msg);
            };
        }

        queue(cmd, timeout) {
            const {length} = this.commandQueue;
            this.commandQueue = this.commandQueue.filter(q => {
                const c = q.cmd;
                const cmdZclDataKeys = Object.keys(cmd.zclData);
                return (
                    c.ieeeAddr !== cmd.ieeeAddr ||
                    c.ep !== cmd.ep ||
                    c.cmdType !== cmd.cmdType ||
                    c.cmd !== cmd.cmd ||
                    !Object.keys(c.zclData).every(key => cmdZclDataKeys.includes(key))
                );
            });

            this.trace('dropped ' + (length - this.commandQueue.length) + ' queued commands');

            if (this.commandQueue.length < this.queueMaxLength) {
                this.commandQueue.push({cmd, timeout});
                this.shiftQueue();
            } else {
                this.error('maximum commandQueue length exceeded, ignoring command');
            }
        }

        shiftQueue() {
            if ((this.commandQueue.length > 0) && !this.cmdPending) {
                this.cmdPending = true;
                const {cmd, timeout} = this.commandQueue.shift();

                const endpoint = this.shepherd.find(cmd.ieeeAddr, cmd.ep);

                if (!endpoint) {
                    this.error('endpoint not found ' + cmd.ieeeAddr + ' ' + cmd.ep);
                    if (typeof cmd.callback === 'function') {
                        cmd.callback(new Error('endpoint not found'));
                    }

                    this.cmdPending = false;
                    this.shiftQueue();
                    return;
                }

                const start = (new Date()).getTime();

                cmd.cmdType = cmd.cmdType || 'foundation';

                switch (cmd.cmdType) {
                    case 'foundation':
                    case 'functional':
                        this.debug(cmd.cmdType + ' ' + this.logName(cmd.ieeeAddr) + ' ' + cmd.cid + ' ' + cmd.cmd + ' ' + JSON.stringify(cmd.zclData) + ' ' + JSON.stringify(Object.assign({disBlockQueue: cmd.disBlockQueue}, cmd.cfg)) + ' timeout=' + timeout);

                        if (cmd.cfg && cmd.cfg.disDefaultRsp) {
                            endpoint[cmd.cmdType](cmd.cid, cmd.cmd, cmd.zclData, cmd.cfg, () => {});
                            setTimeout(() => {
                                this.cmdPending = false;
                                this.shiftQueue();
                            }, this.queuePause);
                        } else {
                            let queueShifted = false;

                            const timer = setTimeout(() => {
                                if (typeof cmd.callback === 'function') {
                                    const {callback} = cmd;
                                    delete cmd.callback;
                                    callback(new Error('timeout'));
                                }

                                if (!cmd.disBlockQueue) {
                                    this.cmdPending = false;
                                    if (!queueShifted) {
                                        queueShifted = true;
                                        this.shiftQueue();
                                    }
                                }
                            }, timeout || this.queueMaxWait);

                            endpoint[cmd.cmdType](cmd.cid, cmd.cmd, cmd.zclData, cmd.cfg, (err, res) => {
                                clearTimeout(timer);
                                if (!cmd.disBlockQueue) {
                                    const elapsed = (new Date()).getTime() - start;
                                    const pause = elapsed > this.queuePause ? 0 : (this.queuePause - elapsed);
                                    setTimeout(() => {
                                        this.cmdPending = false;
                                        if (!queueShifted) {
                                            queueShifted = true;
                                            this.shiftQueue();
                                        }
                                    }, pause);
                                    this.debug('blockQueue elapsed ' + elapsed + 'ms, wait ' + pause + 'ms');
                                }

                                if (err) {
                                    this.error(err.message);
                                    if (this.devices[cmd.ieeeAddr].status === 'online') {
                                        this.devices[cmd.ieeeAddr].status = 'offline';
                                        this.emit('devices', this.devices);
                                    }
                                } else {
                                    this.debug('defaultRsp ' + cmd.cmdType + ' ' + this.logName(cmd.ieeeAddr) + ' ' + cmd.cid + ' ' + cmd.cmd + ' ' + JSON.stringify(res));

                                    if (this.devices[cmd.ieeeAddr].status === 'offline') {
                                        this.devices[cmd.ieeeAddr].status = 'online';
                                        this.emit('devices', this.devices);
                                    }
                                }

                                if (typeof cmd.callback === 'function') {
                                    cmd.callback(err, res);
                                }
                            });
                            if (cmd.disBlockQueue) {
                                setTimeout(() => {
                                    this.cmdPending = false;
                                    if (!queueShifted) {
                                        queueShifted = true;
                                        this.shiftQueue();
                                    }
                                }, this.queuePause);
                            }
                        }

                        break;
                    case 'write': {
                        const timer = setTimeout(() => {
                            this.warn('timeout ' + cmd.cmdType + ' ' + this.logName(cmd.ieeeAddr) + ' ' + cmd.cid + ' ' + cmd.attrId);
                            if (typeof cmd.callback === 'function') {
                                const {callback} = cmd;
                                delete cmd.callback;
                                callback(new Error('timeout'));
                            }

                            if (!cmd.disBlockQueue) {
                                this.cmdPending = false;
                                this.shiftQueue();
                            }
                        }, timeout || this.queueMaxWait);

                        this.debug(cmd.cmdType + ' ' + this.logName(cmd.ieeeAddr) + ' ' + cmd.cid + ' ' + cmd.attrId + ' ' + JSON.stringify(cmd.data));
                        endpoint[cmd.cmdType](cmd.cid, cmd.attrId, cmd.data, (err, res) => {
                            clearTimeout(timer);
                            if (!cmd.disBlockQueue) {
                                const elapsed = (new Date()).getTime() - start;
                                const pause = elapsed > this.queuePause ? 0 : (this.queuePause - elapsed);
                                setTimeout(() => {
                                    this.cmdPending = false;
                                    this.shiftQueue();
                                }, pause);
                                this.debug('blockQueue elapsed ' + elapsed + 'ms, wait ' + pause + 'ms');
                            }

                            if (err) {
                                this.error(err.message);
                                if (this.devices[cmd.ieeeAddr].status === 'online') {
                                    this.devices[cmd.ieeeAddr].status = 'offline';
                                    this.emit('devices', this.devices);
                                }
                            } else {
                                this.debug('defaultRsp ' + cmd.cmdType + ' ' + this.logName(cmd.ieeeAddr) + ' ' + cmd.cid + ' ' + cmd.attrId + ' ' + JSON.stringify(res));
                                if (this.devices[cmd.ieeeAddr].status === 'offline') {
                                    this.devices[cmd.ieeeAddr].status = 'online';
                                    this.emit('devices', this.devices);
                                }
                            }

                            if (typeof cmd.callback === 'function') {
                                cmd.callback(err, res);
                            }
                        });
                        if (cmd.disBlockQueue) {
                            setTimeout(() => {
                                this.cmdPending = false;
                                this.shiftQueue();
                            }, this.queuePause);
                        }

                        break;
                    }

                    case 'read': {
                        const timer = setTimeout(() => {
                            this.warn('timeout ' + cmd.cmdType + ' ' + this.logName(cmd.ieeeAddr) + ' ' + cmd.cid + ' ' + cmd.attrId);
                            if (typeof cmd.callback === 'function') {
                                const {callback} = cmd;
                                delete cmd.callback;
                                callback(new Error('timeout'));
                            }

                            if (!cmd.disBlockQueue) {
                                this.cmdPending = false;
                                this.shiftQueue();
                            }
                        }, timeout || this.queueMaxWait);

                        this.debug(cmd.cmdType + ' ' + this.logName(cmd.ieeeAddr) + ' ' + cmd.cid + ' ' + cmd.attrId);
                        endpoint[cmd.cmdType](cmd.cid, cmd.attrId, (err, res) => {
                            clearTimeout(timer);
                            if (!cmd.disBlockQueue) {
                                const elapsed = (new Date()).getTime() - start;
                                const pause = elapsed > this.queuePause ? 0 : (this.queuePause - elapsed);
                                setTimeout(() => {
                                    this.cmdPending = false;
                                    this.shiftQueue();
                                }, pause);
                                this.debug('blockQueue elapsed ' + elapsed + 'ms, wait ' + pause + 'ms');
                            }

                            if (err) {
                                this.error(err.message);
                                if (this.devices[cmd.ieeeAddr].status === 'online') {
                                    this.devices[cmd.ieeeAddr].status = 'offline';
                                    this.emit('devices', this.devices);
                                }
                            } else {
                                this.debug('defaultRsp ' + cmd.cmdType + ' ' + this.logName(cmd.ieeeAddr) + ' ' + cmd.cid + ' ' + cmd.attrId + ' ' + JSON.stringify(res));
                                if (this.devices[cmd.ieeeAddr].status === 'offline') {
                                    this.devices[cmd.ieeeAddr].status = 'online';
                                    this.emit('devices', this.devices);
                                }
                            }

                            if (typeof cmd.callback === 'function') {
                                cmd.callback(err, res);
                            }
                        });
                        if (cmd.disBlockQueue) {
                            setTimeout(() => {
                                this.cmdPending = false;
                                this.shiftQueue();
                            }, this.queuePause);
                        }

                        break;
                    }

                    case 'bind':
                    case 'unbind': {
                        const dstEpOrGrpId = cmd.destination === 'group' ? cmd.dstGroup : this.shepherd.find(cmd.dstIeeeAddr, cmd.dstEp);
                        const dstDesc = cmd.destination === 'group' ? cmd.dstGroup : (((this.devices[cmd.dstIeeeAddr] && this.devices[cmd.dstIeeeAddr].name) || cmd.dstIeeeAddr) + ' ' + cmd.dstEp);

                        const timer = setTimeout(() => {
                            this.warn('timeout ' + cmd.cmdType + ' ' + this.logName(cmd.ieeeAddr) + ' ' + cmd.cid + ' ' + dstDesc);
                            if (typeof cmd.callback === 'function') {
                                const {callback} = cmd;
                                delete cmd.callback;
                                callback(new Error('timeout'));
                            }

                            if (!cmd.disBlockQueue) {
                                this.cmdPending = false;
                                this.shiftQueue();
                            }
                        }, timeout || this.queueMaxWait);

                        this.debug(cmd.cmdType + ' ' + this.logName(cmd.ieeeAddr) + ' ' + cmd.cid + ' ' + dstDesc);
                        endpoint[cmd.cmdType](cmd.cid, dstEpOrGrpId, (err, res) => {
                            clearTimeout(timer);
                            if (!cmd.disBlockQueue) {
                                const elapsed = (new Date()).getTime() - start;
                                const pause = elapsed > this.queuePause ? 0 : (this.queuePause - elapsed);
                                setTimeout(() => {
                                    this.cmdPending = false;
                                    this.shiftQueue();
                                }, pause);
                                this.debug('blockQueue elapsed ' + elapsed + 'ms, wait ' + pause + 'ms');
                            }

                            if (err) {
                                this.error(err.message);
                            } else {
                                this.debug('defaultRsp ' + cmd.cmdType + ' ' + this.logName(cmd.ieeeAddr) + ' ' + cmd.cid + ' ' + dstDesc + ' ' + JSON.stringify(res));
                            }

                            if (typeof cmd.callback === 'function') {
                                cmd.callback(err, res);
                            }
                        });
                        if (cmd.disBlockQueue) {
                            setTimeout(() => {
                                this.cmdPending = false;
                                this.shiftQueue();
                            }, this.queuePause);
                        }

                        break;
                    }

                    case 'report': {
                        const timer = setTimeout(() => {
                            this.warn('timeout ' + cmd.cmdType + ' ' + this.logName(cmd.ieeeAddr) + ' ' + cmd.cid + ' ' + cmd.cmd);
                            if (typeof cmd.callback === 'function') {
                                const {callback} = cmd;
                                delete cmd.callback;
                                callback(new Error('timeout'));
                            }

                            if (!cmd.disBlockQueue) {
                                this.cmdPending = false;
                                this.shiftQueue();
                            }
                        }, timeout || this.queueMaxWait);

                        this.debug(cmd.cmdType + ' ' + this.logName(cmd.ieeeAddr) + ' ' + cmd.cid + ' ' + cmd.attrId + ' ' + cmd.minInt + ' ' + cmd.maxInt + ' ' + cmd.repChange);
                        endpoint.report(cmd.cid, cmd.attrId, cmd.minInt, cmd.maxInt, cmd.repChange, (err, res) => {
                            clearTimeout(timer);
                            if (!cmd.disBlockQueue) {
                                const elapsed = (new Date()).getTime() - start;
                                const pause = elapsed > this.queuePause ? 0 : (this.queuePause - elapsed);
                                setTimeout(() => {
                                    this.cmdPending = false;
                                    this.shiftQueue();
                                }, pause);
                                this.debug('blockQueue elapsed ' + elapsed + 'ms, wait ' + pause + 'ms');
                            }

                            if (err) {
                                this.error(err.message);
                                if (this.devices[cmd.ieeeAddr].status === 'online') {
                                    this.devices[cmd.ieeeAddr].status = 'offline';
                                    this.emit('devices', this.devices);
                                }
                            } else {
                                this.debug('defaultRsp ' + cmd.cmdType + ' ' + this.logName(cmd.ieeeAddr) + ' ' + cmd.cid + ' ' + cmd.attrId + ' ' + JSON.stringify(res));
                                if (this.devices[cmd.ieeeAddr].status === 'offline') {
                                    this.devices[cmd.ieeeAddr].status = 'online';
                                    this.emit('devices', this.devices);
                                }
                            }

                            if (typeof cmd.callback === 'function') {
                                cmd.callback(err, res);
                            }
                        });
                        if (cmd.disBlockQueue) {
                            setTimeout(() => {
                                this.cmdPending = false;
                                this.shiftQueue();
                            }, this.queuePause);
                        }

                        break;
                    }

                    default:
                        this.error('cmdType ' + cmd.cmdType + ' not supported');
                        this.cmdPending = false;
                        this.shiftQueue();
                }
            }
        }
    }

    class ZigbeeShepherd {
        constructor(config) {
            RED.nodes.createNode(this, config);

            this.persistPath = path.join(RED.settings.userDir, 'zigbee', this.id);
            this.log('persistPath ' + this.persistPath);
            if (!fs.existsSync(this.persistPath)) {
                this.log('mkdirp ' + this.persistPath);
                mkdirp.sync(this.persistPath);
            }

            this.namesPath = path.join(this.persistPath, 'names.json');
            this.dbPath = path.join(this.persistPath, 'dev.db');
            this.led = config.led;

            shepherdNodes[this.id] = this;

            try {
                devices[this.id] = JSON.parse(fs.readFileSync(this.namesPath).toString());
            } catch (error) {
                this.warn(error);
            }

            if (!devices[this.id]) {
                devices[this.id] = {};
            }

            if (!lights[this.id]) {
                lights[this.id] = {};
            }

            this.devices = devices[this.id];
            this.lights = lights[this.id];
            this.lightsInternal = {};
            this.retryTimer = {};

            let precfgkey;
            if (this.credentials.precfgkey) {
                const bytes = this.credentials.precfgkey.match(/[0-9a-fA-F]{2}/gi);
                precfgkey = bytes.map(t => parseInt(t, 16));
            }

            let panId = 0xFFFF;
            if (this.credentials.panId) {
                panId = parseInt(this.credentials.panId, 16);
            }

            this.shepherdOptions = {
                sp: {
                    baudRate: parseInt(config.baudRate, 10) || 115200,
                    rtscts: Boolean(config.rtscts)
                },
                net: {
                    panId,
                    precfgkey,
                    channelList: config.channelList
                },
                dbPath: this.dbPath
            };

            if (!shepherdInstances[this.id]) {
                shepherdInstances[this.id] = new Shepherd(config.path, this.shepherdOptions);
            }

            this.shepherd = shepherdInstances[this.id];

            this.proxy = new ShepherdProxy(this);

            //this.shepherd = new Shepherd(config.path, this.shepherdOptions);

            const listeners = {
                devices: () => this.devicesHandler(),
                ready: () => this.readyHandler(),
                error: error => this.errorHandler(error),
                ind: msg => this.indHandler(msg),
                permitJoining: joinTimeLeft => this.permitJoiningHandler(joinTimeLeft)
            };

            Object.keys(listeners).forEach(event => {
                this.shepherd.on(event, listeners[event]);
            });

            this.proxy.emit('nodeStatus', {fill: 'yellow', shape: 'dot', text: 'starting'});
            this.log('connecting ' + config.path + ' ' + JSON.stringify(this.shepherdOptions.sp));
            this.shepherd.start(error => {
                if (error) {
                    this.proxy.emit('nodeStatus', {fill: 'red', shape: 'ring', text: error.message + ', retrying'});
                    this.error(error.message + ', retrying');
                    this.shepherd.controller._znp.close((() => null));

                    setTimeout(() => {
                        this.shepherd.start(error => {
                            if (error) {
                                this.proxy.emit('nodeStatus', {fill: 'red', shape: 'dot', text: error.message});
                                this.error(error.message);
                            } else {
                                this.proxy.emit('nodeStatus', {fill: 'yellow', shape: 'dot', text: 'connecting'});
                                this.logStartupInfo();
                            }
                        });
                    }, 60000);
                } else {
                    this.proxy.emit('nodeStatus', {fill: 'yellow', shape: 'dot', text: 'connecting'});
                    this.logStartupInfo();
                }
            });

            const checkOverdueInterval = setInterval(() => {
                this.checkOverdue();
            }, 60000);

            this.on('close', done => {
                this.debug('stopping');
                clearInterval(checkOverdueInterval);
                this.proxy.emit('nodeStatus', {fill: 'yellow', shape: 'ring', text: 'closing'});
                this.shepherd.stop(() => {
                    Object.keys(listeners).forEach(event => {
                        this.shepherd.removeListener(event, listeners[event]);
                    });
                    this.proxy.emit('nodeStatus', {});
                    setTimeout(() => {
                        this.proxy.removeAllListeners();
                        this.trace('removed event listeners');
                        this.debug('stopped shepherd');
                        done();
                    }, 100);
                });
            });
        }

        logStartupInfo() {
            const shepherdInfo = this.shepherd.info();
            this.log('coordinator ' + shepherdInfo.net.ieeeAddr + ' firmware version: ' + shepherdInfo.firmware.version + ' ' + shepherdInfo.firmware.revision);
            this.log('started panId: ' + shepherdInfo.net.panId + ' channel: ' + shepherdInfo.net.channel + ' (' + this.shepherdOptions.net.channelList.join(', ') + ')');
        }

        configure() {
            Object.keys(this.devices).forEach(ieeeAddr => {
                const dev = this.devices[ieeeAddr];

                if (!dev || dev.type === 'Coordinator' || configured.has(ieeeAddr)) {
                    return;
                }

                const mappedDevice = shepherdConverters.findByZigbeeModel(dev.modelId);

                if (mappedDevice) {
                    if (mappedDevice.configure) {
                        this.debug(`configure ${this.logName(ieeeAddr)}`);
                        mappedDevice.configure(ieeeAddr, this.shepherd, this.shepherd.find(this.shepherd.info().net.ieeeAddr, 1), success => {
                            if (success) {
                                this.log(`successfully configured ${this.logName(ieeeAddr)}`);
                                configured.add(ieeeAddr);
                            } else {
                                this.error(`configure failed ${this.logName(ieeeAddr)}`);
                            }
                        });
                    }
                }
            });
        }

        readyHandler() {
            this.log('ready');
            this.list();
            const now = (new Date()).getTime();

            this.log(`Currently ${Object.keys(this.devices).length - 1} devices are joined:`);
            Object.keys(this.devices).forEach(ieeeAddr => {
                const dev = this.devices[ieeeAddr];

                if (!dev || dev.type === 'Coordinator') {
                    return;
                }

                this.log(`${ieeeAddr} ${dev.name} (${dev.type} ${dev.manufName} ${dev.modelId})`);
                this.devices[ieeeAddr].ts = now;
                delete this.devices[ieeeAddr].overdue;

                this.initLight(ieeeAddr);
            });

            this.proxy.emit('ready');
            this.proxy.emit('nodeStatus', {fill: 'green', shape: 'dot', text: 'connected'});
            this.shepherd.controller.request('UTIL', 'ledControl', {ledid: 3, mode: this.led === 'enabled' ? 1 : 0});

            this.configure();
        }

        errorHandler(error) {
            this.error(error);
            //this.proxy.emit('error', error);
        }

        indHandler(msg) {
            const now = (new Date()).getTime();
            let ieeeAddr;

            if (msg.type === 'devIncoming' || msg.type === 'devLeaving') {
                this.log('indHandler ' + msg.type + ' ' + this.logName(msg.data));
                this.list();
            } else if (msg.type === 'devInterview') {
                this.log('indHandler ' + msg.type + ' ' + this.logName(msg.data));
            } else {
                const firstEp = (msg && msg.endpoints && msg.endpoints[0]) || {};
                ieeeAddr = firstEp.device && firstEp.device.ieeeAddr;
                this.debug('indHandler ' + msg.type + ' ' + this.logName(ieeeAddr) + ' ' + JSON.stringify(msg.data));

                let stateChange;
                if (this.devices[ieeeAddr]) {
                    this.devices[ieeeAddr].ts = now;
                    if (this.devices[ieeeAddr].overdue !== false || this.devices[ieeeAddr].status === 'offline') {
                        const timeout = interval[this.devices[ieeeAddr].modelId];
                        if (timeout) {
                            this.debug('overdue false ' + this.logName(ieeeAddr));
                            this.devices[ieeeAddr].overdue = false;
                            stateChange = true;
                        }
                    }

                    if (this.devices[ieeeAddr].status === 'offline') {
                        this.devices[ieeeAddr].status = 'online';
                        stateChange = true;
                    }

                    if (stateChange) {
                        this.proxy.emit('devices', this.devices);
                    }
                }

                this.indLightHandler(msg);
            }

            this.proxy.emit('ind', msg);
        }

        permitJoiningHandler(joinTimeLeft) {
            if (joinTimeLeft < 0) {
                this.join(1);
            }

            this.proxy.emit('permitJoining', joinTimeLeft);
            this.joinTimeLeft = joinTimeLeft;
        }

        devicesHandler() {
            this.proxy.emit('devices');
        }

        save() {
            fs.writeFile(this.namesPath, JSON.stringify(this.devices, null, '  '), () => {});
        }

        list(addr) {
            const known = [];
            let change = false;
            this.shepherd.list(addr).forEach(dev => {
                known.push(dev.ieeeAddr);
                if (!this.devices[dev.ieeeAddr]) {
                    change = true;
                    this.devices[dev.ieeeAddr] = {name: ''};
                }

                if (!this.devices[dev.ieeeAddr].epDesc) {
                    change = true;
                    this.devices[dev.ieeeAddr].epDesc = [];
                    dev.epList.forEach(epId => {
                        const ep = this.shepherd.find(dev.ieeeAddr, epId);
                        const desc = ep.getSimpleDesc();
                        this.devices[dev.ieeeAddr].epDesc.push(desc);
                    });
                }

                Object.assign(this.devices[dev.ieeeAddr], dev);
            });
            Object.keys(this.devices).forEach(addr => {
                if (!known.includes(addr)) {
                    change = true;
                    delete this.devices[addr];
                }
            });
            if (change) {
                this.save();
                this.debug('device list changed');
            } else {
                this.debug('device list unchanged');
            }

            this.proxy.emit('devices', this.devices);
        }

        remove(addr) {
            this.shepherd.remove(addr, {reJoin: true, rmChildren: false}, error => {
                if (error) {
                    this.error('remove ' + addr + ' ' + error);
                } else {
                    this.log('removed ' + addr);
                }
            });
        }

        join(time, type) {
            this.log('permitJoin ' + time + ' ' + type);
            if (time) {
                this.shepherd.permitJoin(time, type);
            } else {
                this.shepherd.permitJoin(1, type);
            }
        }

        checkOverdue() {
            const now = (new Date()).getTime();
            let change = false;
            Object.keys(this.devices).forEach(ieeeAddr => {
                const elapsed = Math.round((now - this.devices[ieeeAddr]) / 60000);
                const timeout = interval[this.devices[ieeeAddr].modelId];
                if (timeout && (elapsed > timeout) && (this.devices[ieeeAddr].overdue !== true)) {
                    change = true;
                    this.log('overdue true ' + this.logName(ieeeAddr));
                    this.devices[ieeeAddr].overdue = true;
                }
            });
            if (change) {
                this.proxy.emit('devices', this.devices);
            }
        }

        initLight(ieeeAddr) {
            this.currentIndex = this.currentIndex || 1;
            const dev = this.devices[ieeeAddr];
            const epFirst = this.shepherd.find(ieeeAddr, dev.epList[0]);
            const desc = epFirst.getSimpleDesc();
            const type = zllDevice[desc.devId];
            if (type && dev.modelId !== 'lumi.router') {
                this.lightsInternal[this.currentIndex] = {ieeeAddr, type, knownStates: {}};

                const uniqueid = ieeeAddr.replace('0x', '').replace(/([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/, '$1:$2:$3:$4:$5:$6:$7:$8') + '-' + (uniqueidSuffix[dev.manufName] || '00');

                this.lights[String(this.currentIndex)] = {
                    state: emptyStates[type] || {on: false, reachable: false},
                    type,
                    name: dev.name,
                    modelid: dev.modelId,
                    manufacturername: dev.manufName,
                    uniqueid,
                    // TODO clarify: can we retrieve the sw version from the shepherd?
                    swversion: '',
                    // Todo clarify: what is pointsymbol's purpose?
                    pointsymbol: {
                        1: 'none',
                        2: 'none',
                        3: 'none',
                        4: 'none',
                        5: 'none',
                        6: 'none',
                        7: 'none',
                        8: 'none'
                    }
                };
                this.currentIndex += 1;
            }
        }

        /**
         * @param {string} search id, ieeeAddr or name
         * @returns {null|string}
         */
        getLightIndex(search) {
            let found = null;

            if (search.startsWith('0x')) {
                Object.keys(this.lightsInternal).forEach(index => {
                    if (this.lightsInternal[index] && (this.lightsInternal[index].ieeeAddr === search)) {
                        found = index;
                    }
                });
            } else if (this.lights[search]) {
                found = search;
            } else {
                Object.keys(this.lights).forEach(index => {
                    if (search === this.lights[index].name) {
                        found = index;
                    }
                });
            }

            return found;
        }

        indLightHandler(msg) {
            const ieeeAddr = msg.endpoints && msg.endpoints[0] && msg.endpoints[0].device && msg.endpoints[0].device.ieeeAddr;
            const lightIndex = this.getLightIndex(ieeeAddr);
            if (!lightIndex) {
                return;
            }

            this.debug('indLightHandler ' + this.logName(ieeeAddr) + ' msg.type=' + msg.type + ' msg.data=' + JSON.stringify(msg.data));

            const ziee = msg.endpoints[0].clusters;

            switch (msg.type) {
                case 'devStatus':
                    this.updateLight(lightIndex, {swversion: ziee.genBasic.attrs.swBuildId});
                    this.updateLightState(lightIndex, {reachable: msg.data === 'online'});
                    break;

                case 'attReport':
                case 'devChange':
                case 'readRsp': {
                    const now = (new Date()).getTime();

                    //console.log('indLightHandler ziee', ziee);

                    const state = {reachable: true};

                    if (msg.data && msg.data.cid === 'genOnOff') {
                        state.on = Boolean(msg.data.data.onOff);
                        this.lightsInternal[lightIndex].knownStates.on = now;
                    }

                    if (msg.data && msg.data.cid === 'genLevelCtrl') {
                        state.bri = msg.data.data.currentLevel;
                        this.lightsInternal[lightIndex].knownStates.bri = now;
                    }

                    // TODO use msg.data
                    if (ziee.lightingColorCtrl) {
                        const {attrs} = ziee.lightingColorCtrl;
                        if (typeof attrs.colorTemperature !== 'undefined') {
                            state.ct = attrs.colorTemperature;
                        }

                        if (typeof attrs.enhancedCurrentHue !== 'undefined') {
                            state.hue = attrs.enhancedCurrentHue;
                        }

                        if (typeof attrs.currentSaturation !== 'undefined') {
                            state.sat = attrs.currentSaturation;
                        }

                        if (typeof attrs.currentX !== 'undefined') {
                            state.xy = [attrs.currentX / 65535, attrs.currentY / 65535];
                        }

                        if (typeof attrs.currentSaturation !== 'undefined') {
                            state.sat = attrs.currentSaturation;
                        }

                        if (typeof attrs.colorMode !== 'undefined') {
                            switch (attrs.colorMode) {
                                case 0:
                                    state.colormode = 'hs';
                                    break;
                                case 1:
                                    state.colormode = 'xy';
                                    break;
                                case 2:
                                    state.colormode = 'ct';
                                    break;
                                default:
                            }
                        }
                    }

                    this.updateLightState(lightIndex, state);
                    break;
                }

                default:
            }
        }

        updateLight(lightIndex, data) {
            if (oe.extend(this.lights[lightIndex], data)) {
                this.proxy.emit('updateLight', lightIndex);
            }
        }

        updateLightState(lightIndex, data) {
            Object.keys(data).forEach(attr => {
                if (typeof data[attr] === 'undefined') {
                    delete data[attr];
                }
            });

            if (oe.extend(this.lights[lightIndex].state, data)) {
                this.proxy.emit('updateLightState', lightIndex);
            }
        }

        putLightsState(msg, retryCount = 0) {
            //console.log('putLightsState', msg);
            // xy > ct > hs
            // on bool
            // bri uint8 0-254
            // bri uint8 1-254: // TODO some lights seem to not accept a 0 bri and return to 1?
            //      Osram Gardenpole RGBW-Lightify
            //
            //
            // hue uint16 0-65535
            // sat uint8 0-254
            // xy [float,float] 0-1
            // ct uint16 153-500
            // alert string "none", "select", "lselect"
            // effect string "none" "colorloop"
            // transitiontime uint16
            // bri_inc -254-254
            // sat_inc -254-254
            // hue_inc -65534-65534
            // ct_inc -65534-65534
            // xy_inc [] 0.5 0.5

            const lightIndex = msg.topic.match(/lights\/(\d+)\/state/)[1];
            const {ieeeAddr} = this.lightsInternal[lightIndex];

            if (!ieeeAddr) {
                this.error('unknown light ' + lightIndex);
                return;
            }

            const dev = this.devices[ieeeAddr];

            const cmds = [];

            clearTimeout(this.retryTimer[ieeeAddr]);

            const retry = () => {
                if (retryCount++ < 3) {
                    this.retryTimer[ieeeAddr] = setTimeout(() => {
                        this.debug('putLightState retry ' + retryCount);
                        this.putLightsState(msg, retryCount);
                    }, 250);
                }
            };

            const attributes = [];

            if (typeof msg.payload.on !== 'undefined' && typeof msg.payload.bri === 'undefined') {
                //if (this.lightsInternal[lightIndex].knownStates.on && (msg.payload.on === this.lights[lightIndex].state.on)) {
                //    this.debug(dev.name + ' skip command - on ' + msg.payload.on);
                //} else  {
                if (msg.payload.transitiontime) {
                    attributes.push('on');
                    attributes.push('bri');
                    cmds.push({
                        ieeeAddr: dev.ieeeAddr,
                        ep: dev.epList[0],
                        cmdType: 'functional',
                        cid: 'genLevelCtrl',
                        cmd: 'moveToLevelWithOnOff',
                        zclData: {
                            level: msg.payload.on ? 254 : 0,
                            transtime: msg.payload.transitiontime || 0
                        },
                        cfg: {
                            disDefaultRsp: 1
                        },
                        disBlockQueue: true,
                        callback: (err, res) => {
                            this.handlePutLightStateCallback(err, res, lightIndex, msg, attributes, dev.ieeeAddr) || retry();
                        }
                    });
                } else {
                    attributes.push('on');
                    cmds.push({
                        ieeeAddr: dev.ieeeAddr,
                        ep: dev.epList[0],
                        cmdType: 'functional',
                        cid: 'genOnOff',
                        cmd: msg.payload.on ? 'on' : 'off',
                        zclData: {},
                        cfg: {
                            disDefaultRsp: 1
                        },
                        disBlockQueue: true,
                        callback: (err, res) => {
                            this.handlePutLightStateCallback(err, res, lightIndex, msg, attributes, dev.ieeeAddr) || retry();
                        }
                    });
                }
                //}
            }

            if (typeof msg.payload.bri !== 'undefined') {
                //if (
                //    (this.lightsInternal[lightIndex].knownStates.bri && (msg.payload.bri === this.lights[lightIndex].state.bri) &&
                //    !(this.lightsInternal[lightIndex].knownStates.on && this.lights[lightIndex].state.on === false && msg.payload.bri > 0) &&
                //    !(this.lightsInternal[lightIndex].knownStates.on && this.lights[lightIndex].state.on === true && msg.payload.bri === 0)
                //)) {
                //    this.debug(dev.name + ' skip command - bri ' + msg.payload.bri);
                //} else {
                attributes.push('on');
                attributes.push('bri');

                let level = msg.payload.bri;

                if (level > 254) {
                    level = 254;
                }

                cmds.push({
                    ieeeAddr: dev.ieeeAddr,
                    ep: dev.epList[0],
                    cmdType: 'functional',
                    cid: 'genLevelCtrl',
                    // Todo: clarify - bri 1 sets off?
                    cmd: 'moveToLevelWithOnOff',
                    zclData: {
                        level,
                        transtime: msg.payload.transitiontime || 0
                    },
                    cfg: {
                        disDefaultRsp: 1
                    },
                    disBlockQueue: true,
                    callback: (err, res) => {
                        this.handlePutLightStateCallback(err, res, lightIndex, msg, attributes, dev.ieeeAddr) || retry();
                    }
                });
                //}
            } else if (typeof msg.payload.bri_inc !== 'undefined') {
                attributes.push('bri');
                cmds.push({
                    ieeeAddr: dev.ieeeAddr,
                    ep: dev.epList[0],
                    cmdType: 'functional',
                    cid: 'genLevelCtrl',
                    cmd: 'step',
                    zclData: {
                        // Todo clarify stepmode values expected by shepherd.
                        // Spec defines up=0x01 down=0x03, shepherd seems to use up=false down=true ?
                        stepmode: msg.payload.bri_inc < 0,
                        stepsize: Math.abs(msg.payload.bri_inc),
                        transtime: msg.payload.transitiontime || 0
                    },
                    cfg: {
                        disDefaultRsp: 1
                    },
                    disBlockQueue: true,
                    callback: (err, res) => {
                        this.handlePutLightStateCallback(err, res, lightIndex, msg, attributes, dev.ieeeAddr) || retry();
                    }
                });
            }

            if (typeof msg.payload.xy !== 'undefined') {
                attributes.push('xy');
                cmds.push({
                    ieeeAddr: dev.ieeeAddr,
                    ep: dev.epList[0],
                    cmdType: 'functional',
                    cid: 'lightingColorCtrl',
                    cmd: 'moveToColor',
                    zclData: {
                        colorx: Math.round(msg.payload.xy[0] * 65535),
                        colory: Math.round(msg.payload.xy[1] * 65535),
                        transtime: msg.payload.transitiontime || 0
                    },
                    cfg: {
                        disDefaultRsp: 1
                    },
                    disBlockQueue: true,
                    callback: (err, res) => {
                        this.handlePutLightStateCallback(err, res, lightIndex, msg, attributes, dev.ieeeAddr);
                    }
                });
            } else if (typeof msg.payload.xy_inc !== 'undefined') {
                attributes.push('xy');
                cmds.push({
                    ieeeAddr: dev.ieeeAddr,
                    ep: dev.epList[0],
                    cmdType: 'functional',
                    cid: 'lightingColorCtrl',
                    cmd: 'stepColor',
                    zclData: {
                        stepx: Math.round(msg.payload.xy_inc[0] * 65535),
                        stepy: Math.round(msg.payload.xy_inc[1] * 65535),
                        transtime: msg.payload.transitiontime || 0
                    },
                    cfg: {
                        disDefaultRsp: 1
                    },
                    disBlockQueue: true,
                    callback: (err, res) => {
                        this.handlePutLightStateCallback(err, res, lightIndex, msg, attributes, dev.ieeeAddr) || retry();
                    }
                });
            } else if (typeof msg.payload.ct !== 'undefined') {
                attributes.push('ct');

                cmds.push({
                    ieeeAddr: dev.ieeeAddr,
                    ep: dev.epList[0],
                    cmdType: 'functional',
                    cid: 'lightingColorCtrl',
                    cmd: 'moveToColorTemp',
                    zclData: {
                        colortemp: msg.payload.ct,
                        transtime: msg.payload.transitiontime || 0
                    },
                    cfg: {
                        disDefaultRsp: 1
                    },
                    disBlockQueue: true,
                    callback: (err, res) => {
                        this.handlePutLightStateCallback(err, res, lightIndex, msg, attributes, dev.ieeeAddr) || retry();
                    }
                });
            } else if (typeof msg.payload.ct_inc !== 'undefined') {
                // Todo - clarify: it seems there is no stepColorTemperature cmd - need to know the current ct value?
            } else if (typeof msg.payload.hue !== 'undefined' && typeof msg.payload.sat !== 'undefined') {
                attributes.push('hue');
                attributes.push('sat');

                cmds.push({
                    ieeeAddr: dev.ieeeAddr,
                    ep: dev.epList[0],
                    cmdType: 'functional',
                    cid: 'lightingColorCtrl',
                    cmd: 'enhancedMoveToHueAndSaturation',
                    zclData: {
                        enhancehue: msg.payload.hue,
                        saturation: msg.payload.sat,
                        transtime: msg.payload.transitiontime || 0
                    },
                    cfg: {
                        disDefaultRsp: 1
                    },
                    disBlockQueue: true,
                    callback: (err, res) => {
                        this.handlePutLightStateCallback(err, res, lightIndex, msg, attributes, dev.ieeeAddr) || retry();
                    }
                });
            } else if (typeof msg.payload.hue === 'undefined') {
                if (typeof msg.payload.sat !== 'undefined') {
                    attributes.push('sat');

                    cmds.push({
                        ieeeAddr: dev.ieeeAddr,
                        ep: dev.epList[0],
                        cmdType: 'functional',
                        cid: 'lightingColorCtrl',
                        cmd: 'moveToSaturation',
                        zclData: {
                            saturation: msg.payload.sat,
                            transtime: msg.payload.transitiontime || 0
                        },
                        cfg: {
                            disDefaultRsp: 1
                        },
                        disBlockQueue: true,
                        callback: (err, res) => {
                            this.handlePutLightStateCallback(err, res, lightIndex, msg, attributes, dev.ieeeAddr) || retry();
                        }
                    });
                } else if (typeof msg.payload.hue_inc !== 'undefined' && typeof msg.payload.sat_inc !== 'undefined') {
                    // TODO
                } else if (typeof msg.payload.hue_inc !== 'undefined') {
                    // TODO
                } else if (typeof msg.payload.sat_inc !== 'undefined') {
                    // TODO
                }
            } else {
                attributes.push('hue');

                cmds.push({
                    ieeeAddr: dev.ieeeAddr,
                    ep: dev.epList[0],
                    cmdType: 'functional',
                    cid: 'lightingColorCtrl',
                    cmd: 'enhancedMoveToHue',
                    zclData: {
                        enhancehue: msg.payload.hue,
                        direction: msg.payload.direction || 0,
                        transtime: msg.payload.transitiontime || 0
                    },
                    cfg: {
                        disDefaultRsp: 1
                    },
                    disBlockQueue: true,
                    callback: (err, res) => {
                        this.handlePutLightStateCallback(err, res, lightIndex, msg, attributes, dev.ieeeAddr) || retry();
                    }
                });
            }

            if (typeof msg.payload.alert !== 'undefined') {
                let effectid;
                let val = msg.payload.alert;
                switch (val) {
                    case 'select':
                        effectid = 0;
                        break;
                    case 'lselect':
                        effectid = 1;
                        break;
                    default:
                        val = 'none';
                        effectid = 255;
                }

                cmds.push({
                    ieeeAddr: dev.ieeeAddr,
                    ep: dev.epList[0],
                    cmdType: 'functional',
                    cid: 'genIdentify',
                    cmd: 'triggerEffect',
                    zclData: {
                        effectid,
                        effectvariant: 1
                    },
                    cfg: {
                        disDefaultRsp: 1
                    },
                    disBlockQueue: true,
                    callback: (err, res) => {
                        this.handlePutLightStateCallback(err, res, lightIndex, msg, [], dev.ieeeAddr) || retry();
                    }
                });
            }

            if (typeof msg.payload.effect !== 'undefined') {
                // TODO
            }

            if (cmds.length > 0) {
                cmds[cmds.length - 1].cfg.disDefaultRsp = 0;
            }

            attributes.forEach(attr => {
                delete this.lightsInternal[lightIndex].knownStates[attr];
            });

            cmds.forEach(cmd => {
                this.proxy.queue(cmd);
            });
        }

        handlePutLightStateCallback(err, res, lightIndex, msg, attributes, ieeeAddr) {
            if (err) {
                this.error('handlePutLightStateCallback ' + this.logName(ieeeAddr) + ' ' + err.message + ' ' + JSON.stringify(attributes) + ' ' + JSON.stringify(res));
            } else {
                this.debug('handlePutLightStateCallback ' + this.logName(ieeeAddr) + ' ' + JSON.stringify(attributes) + ' ' + JSON.stringify(res));
            }

            if (err) {
                const newState = {reachable: false};
                attributes.forEach(attr => {
                    if (typeof msg.payload[attr] !== 'undefined') {
                        newState[attr] = msg.payload[attr];
                    }
                });
                this.lightsInternal[lightIndex].knownStates = {};
                this.updateLightState(lightIndex, newState);
            } else if (msg.payload.transitiontime) {
                setTimeout(() => {
                    this.readLightState(lightIndex, attributes);
                }, (msg.payload.transitiontime * 100) + 1000);
            } else if (res && res.statusCode === 0) {
                const now = (new Date()).getTime();
                const newState = {reachable: true};
                attributes.forEach(attr => {
                    if (typeof msg.payload[attr] !== 'undefined') {
                        this.lightsInternal[lightIndex].knownStates[attr] = now;
                        newState[attr] = msg.payload[attr];
                    }
                });
                this.updateLightState(lightIndex, newState);
            }

            return !err;
        }

        readLightState(lightIndex, attributes) {
            const dev = this.devices[this.lightsInternal[lightIndex].ieeeAddr];
            const cmds = [];
            if (attributes.includes('on')) {
                cmds.push({
                    ieeeAddr: dev.ieeeAddr,
                    ep: dev.epList[0],
                    cmdType: 'foundation',
                    cmd: 'read',
                    cid: 'genOnOff',
                    zclData:
                        [{attrId: 0}],
                    cfg: {
                        disDefaultRsp: 0
                    },
                    disBlockQueue: true
                });
            }

            if (attributes.includes('bri')) {
                cmds.push({
                    ieeeAddr: dev.ieeeAddr,
                    ep: dev.epList[0],
                    cmdType: 'foundation',
                    cmd: 'read',
                    cid: 'genLevelCtrl',
                    zclData:
                        [{attrId: 0}],
                    cfg: {
                        disDefaultRsp: 0
                    },
                    disBlockQueue: true
                });
            }

            cmds.forEach(cmd => {
                this.proxy.queue(cmd);
            });
        }

        logName(ieeeAddr) {
            return this.devices[ieeeAddr] ? `${this.devices[ieeeAddr].name} (${ieeeAddr})` : ieeeAddr;
        }

        checkOnline(ieeeAddr, callback) {
            this.shepherd.controller.checkOnline(this.shepherd._findDevByAddr(ieeeAddr), err => {
                this.debug('checkOnline ' + ieeeAddr + ' ' + err);
                if (typeof callback === 'function') {
                    callback();
                }
            });
        }

        lqiScan(callback) {
            this.log('Starting lqi scan...');
            const lqiScanList = new Set();
            const linkMap = {};
            const scanQueue = [];

            const processLqiResponse = (error, rsp, targetIeeeAddr, targetNwkAddr) => {
                console.log('processLqiResponse', rsp, targetIeeeAddr, targetNwkAddr);
                if (error) {
                    this.warn(`Failed network lqi scan for device: ${this.logName(targetIeeeAddr)} with error: '${error}'`);
                } else if (lqiScanList.has(targetIeeeAddr)) {
                    // Haven't processed this one yet
                    linkMap[targetIeeeAddr] = rsp;
                } else {
                    // This target has already had timeout so don't add to result network map
                    this.warn(`Ignoring late network lqi scan result for: ${this.logName(targetIeeeAddr)}`);
                }
            };

            const shiftScanQueue = cb => {
                const f = scanQueue.shift();
                if (f) {
                    f(() => {
                        shiftScanQueue(cb);
                    });
                } else {
                    cb();
                }
            };

            const queueScans = () => {
                Object.keys(this.devices).filter(ieeeAddr => (this.devices[ieeeAddr].type !== 'EndDevice' && this.devices[ieeeAddr].status === 'online')).forEach(ieeeAddr => {
                    const dev = this.devices[ieeeAddr];
                    this.debug(`Queing network scans for device: ${this.logName(dev.ieeeAddr)}`);

                    lqiScanList.add(ieeeAddr);
                    scanQueue.push(queueCallback => {
                        this.debug(`mgmtLqiReq ${this.logName(dev.ieeeAddr)}`);
                        this.shepherd.controller.request('ZDO', 'mgmtLqiReq', {dstaddr: dev.nwkAddr, startindex: 0},
                            (error, rsp) => {
                                processLqiResponse(error, rsp, dev.ieeeAddr, dev.nwkAddr);
                                queueCallback(error);
                            });
                    });
                });

                console.log('lqiScanList', lqiScanList);

                shiftScanQueue(() => {
                    callback(linkMap);
                });
            };

            queueScans();
        }

        rtgScan(callback) {
            this.log('Starting rtg scan...');
            const rtgScanList = new Set();
            const routeMap = {};
            const scanQueue = [];

            const processRtgResponse = (error, rsp, sourceIeeeAddr, sourceNwkAddr) => {
                console.log('processRtgResponse', rsp, sourceIeeeAddr, sourceNwkAddr);
                if (error) {
                    this.warn(`Failed network rtg scan for device: ${this.logName(sourceIeeeAddr)} with error: '${error}'`);
                } else if (rtgScanList.has(sourceIeeeAddr)) {
                    // Haven't processed this one yet
                    routeMap[sourceIeeeAddr] = rsp;
                } else {
                    // This source has already had timeout so don't add to result network map
                    this.warn(`Ignoring late network rtg scan result for: ${this.logName(sourceIeeeAddr)}`);
                }
            };

            const shiftScanQueue = cb => {
                const f = scanQueue.shift();
                if (f) {
                    f(() => {
                        shiftScanQueue(cb);
                    });
                } else {
                    cb();
                }
            };

            const queueScans = () => {
                Object.keys(this.devices).filter(ieeeAddr => (this.devices[ieeeAddr].type !== 'EndDevice' && this.devices[ieeeAddr].status === 'online')).forEach(ieeeAddr => {
                    const dev = this.devices[ieeeAddr];
                    this.debug(`Queing rtg scans for device: ${this.logName(dev.ieeeAddr)}`);

                    rtgScanList.add(ieeeAddr);
                    scanQueue.push(queueCallback => {
                        this.debug(`mgmtRtgReq ${this.logName(dev.ieeeAddr)}`);
                        this.shepherd.controller.request('ZDO', 'mgmtRtgReq', {dstaddr: dev.nwkAddr, startindex: 0},
                            (error, rsp) => {
                                processRtgResponse(error, rsp, dev.ieeeAddr, dev.nwkAddr);
                                queueCallback(error);
                            });
                    });
                });

                console.log('rtgScanList', rtgScanList);

                shiftScanQueue(() => {
                    callback(routeMap);
                });
            };

            //this.shiftScanQueue(queueScans);
            queueScans();
        }
    }

    RED.nodes.registerType('zigbee-shepherd', ZigbeeShepherd, {
        credentials: {
            panId: {type: 'text'},
            precfgkey: {type: 'text'}
        }
    });
};
