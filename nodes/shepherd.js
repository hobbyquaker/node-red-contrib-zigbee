const fs = require('fs');
const path = require('path');
const {EventEmitter} = require('events');

const mkdirp = require('mkdirp');
const Shepherd = require('zigbee-shepherd');

const devices = {};
const shepherdNodes = {};
const shepherdInstances = {};

module.exports = function (RED) {
    RED.httpAdmin.get('/zigbee-shepherd/devices', (req, res) => {
        res.status(200).send(JSON.stringify(devices[req.query.id] || {}));
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

    RED.httpAdmin.get('/zigbee-shepherd/bind', (req, res) => {
        if (shepherdNodes[req.query.id]) {
            shepherdNodes[req.query.id].bind(req.query.deviceSrc, parseInt(req.query.epSrc, 10), req.query.deviceDest, parseInt(req.query.epDest, 10), req.query.groupDest, req.query.cId);
        }

        res.status(200).send('');
    });

    RED.httpAdmin.get('/zigbee-shepherd/unbind', (req, res) => {
        if (shepherdNodes[req.query.id]) {
            shepherdNodes[req.query.id].unbind(req.query.deviceSrc, parseInt(req.query.epSrc, 10), req.query.deviceDest, parseInt(req.query.epDest, 10), req.query.groupDest, req.query.cId);
        }

        res.status(200).send('');
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

            this.shepherdNode = shepherdNode;
            this.shepherd = shepherdNode.shepherd;

            this.queueMaxWait = 5000;
            this.queueMaxLength = 50;
            this.queuePause = 100;
            this.commandQueue = [];

            this.trace = shepherdNode.trace;
            this.debug = shepherdNode.debug;
            this.log = shepherdNode.log;
            this.warn = shepherdNode.warn;
            this.error = shepherdNode.error;
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
                    return;
                }

                this.debug(JSON.stringify(cmd));
                const start = (new Date()).getTime();

                cmd.cmdType = cmd.cmdType || 'foundation';

                switch (cmd.cmdType) {
                    case 'foundation':
                    case 'functional':
                        if (cmd.cfg && cmd.cfg.disDefaultRsp) {
                            endpoint[cmd.cmdType](cmd.cid, cmd.cmd, cmd.zclData, cmd.cfg);
                            setTimeout(() => {
                                this.cmdPending = false;
                                this.shiftQueue();
                            }, this.queuePause);
                        } else {
                            const timer = setTimeout(() => {
                                this.debug('timeout! ' + timeout + ' ' + this.queueMaxWait);
                                if (typeof cmd.callback === 'function') {
                                    cmd.callback(new Error('timeout'));
                                    delete cmd.callback;
                                }

                                if (!cmd.disBlockQueue) {
                                    this.cmdPending = false;
                                    this.shiftQueue();
                                }
                            }, timeout || this.queueMaxWait);

                            endpoint[cmd.cmdType](cmd.cid, cmd.cmd, cmd.zclData, cmd.cfg, (err, res) => {
                                clearTimeout(timer);
                                if (!cmd.disBlockQueue) {
                                    const elapsed = (new Date()).getTime() - start;
                                    const pause = elapsed > this.queuePause ? 0 : (this.queuePause - elapsed);
                                    setTimeout(() => {
                                        this.cmdPending = false;
                                        this.shiftQueue();
                                    }, pause);
                                    this.debug('elapsed ' + elapsed + ' ms -> wait ' + pause + 'ms');
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
                        }

                        break;

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
            mkdirp(this.persistPath);

            this.namesPath = path.join(this.persistPath, 'names.json');
            this.dbPath = path.join(this.persistPath, 'dev.db');

            shepherdNodes[this.id] = this;

            try {
                devices[this.id] = JSON.parse(fs.readFileSync(this.namesPath).toString());
            } catch (error) {
                this.error(error);
            }

            if (!devices[this.id]) {
                devices[this.id] = {};
            }

            this.devices = devices[this.id];

            let precfgkey;
            if (this.credentials.precfgkey) {
                const bytes = this.credentials.precfgkey.match(/[0-9a-fA-F]{2}/gi);
                precfgkey = bytes.map(t => parseInt(t, 16));
            }

            let panId = 0xFFFF;
            if (this.credentials.panId) {
                panId = parseInt(this.credentials.panId, 16);
            }

            const shepherdOptions = {
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
                shepherdInstances[this.id] = new Shepherd(config.path, shepherdOptions);
            }

            this.shepherd = shepherdInstances[this.id];

            this.proxy = new ShepherdProxy(this);

            //this.shepherd = new Shepherd(config.path, shepherdOptions);

            const listeners = {
                ready: () => this.readyHandler(),
                error: error => this.errorHandler(error),
                ind: msg => this.indHandler(msg),
                permitJoining: joinTimeLeft => this.permitJoiningHandler(joinTimeLeft)
            };

            Object.keys(listeners).forEach(event => {
                this.shepherd.on(event, listeners[event]);
            });

            this.proxy.emit('nodeStatus', {fill: 'yellow', shape: 'dot', text: 'starting'});
            this.debug('starting');
            this.shepherd.start(error => {
                if (error) {
                    this.proxy.emit('nodeStatus', {fill: 'red', shape: 'ring', text: error.message});
                    this.error(error);
                } else {
                    this.proxy.emit('nodeStatus', {fill: 'yellow', shape: 'dot', text: 'connecting'});
                    this.debug('started');
                }
            });

            this.on('close', done => {
                this.debug('stopping');
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

        readyHandler() {
            this.log('ready');
            this.list();
            this.proxy.emit('ready');
            this.proxy.emit('nodeStatus', {fill: 'green', shape: 'dot', text: 'connected'});
        }

        errorHandler(error) {
            this.error(error);
            this.proxy.emit('error', error);
        }

        indHandler(msg) {
            this.proxy.emit('ind', msg);
            if (msg.type === 'devIncoming' || msg.type === 'devLeaving') {
                this.debug(msg.type + ' ' + msg.data);
                this.list();
            }
            //this.debug('ind ' + util.inspect(msg, {breakLength: Infinity, depth: 3}));
        }

        permitJoiningHandler(joinTimeLeft) {
            this.proxy.emit('permitJoining', joinTimeLeft);
            this.joinTimeLeft = joinTimeLeft;
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
                this.debug('list: changed!');
            } else {
                this.debug('list: no change');
            }
            this.proxy.emit('devices', this.devices);
        }

        remove(addr) {
            this.log('remove ' + addr);
            this.shepherd.remove(addr, {reJoin: true, rmChildren: false}, error => {
                if (error) {
                    this.error('remove ' + addr + ' ' + error);
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

        bind(deviceSrc, epSrc, deviceDest, epDest, groupDest, cluster) {
            console.log('bind', deviceSrc, epSrc, deviceDest, epDest, groupDest, cluster);
            const endpointSrc = this.shepherd.find(deviceSrc, epSrc);
            if (!endpointSrc) {
                this.error('source endpoint ' + deviceSrc + ' ' + epSrc + ' unkown');
                return;
            }
            const endpointDest = Number(groupDest) || this.shepherd.find(deviceDest, epDest);
            if (!endpointDest) {
                this.error('destination endpoint ' + deviceDest + ' ' + epDest + ' unkown');
                return;
            }
            endpointSrc.bind(cluster, endpointDest, err => {
                if (err) {
                    this.error(err.message);
                } else {
                    this.log('bind successful');
                }
            });
        }
        unbind(deviceSrc, epSrc, deviceDest, epDest, groupDest, cluster) {
            console.log('unbind', deviceSrc, epSrc, deviceDest, epDest, groupDest, cluster);
            const endpointSrc = this.shepherd.find(deviceSrc, epSrc);
            if (!endpointSrc) {
                this.error('source endpoint ' + deviceSrc + ' ' + epSrc + ' unkown');
                return;
            }
            const endpointDest = Number(groupDest) || this.shepherd.find(deviceDest, epDest);
            if (!endpointDest) {
                this.error('destination endpoint ' + deviceDest + ' ' + epDest + ' unkown');
                return;
            }
            endpointSrc.unbind(cluster, endpointDest, err => {
                if (err) {
                    this.error(err.message);
                } else {
                    this.log('unbind successful');
                }
            });
        }
    }

    RED.nodes.registerType('zigbee-shepherd', ZigbeeShepherd, {
        credentials: {
            panId: {type: 'text'},
            precfgkey: {type: 'text'}
        }
    });
};
