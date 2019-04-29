const fs = require('fs');
const path = require('path');
const {EventEmitter} = require('events');

const oe = require('obj-ease');
const mkdirp = require('mkdirp');
const Shepherd = require('zigbee-shepherd');

const interval = require('../interval.json');

const devices = {};
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

    RED.httpAdmin.get('/zigbee-shepherd/graphviz', (req, res) => {
        if (shepherdNodes[req.query.id]) {
            shepherdNodes[req.query.id].shepherd.lqiScan(shepherdNodes[req.query.id].shepherd.controller._coord.ieeeAddr)
                .then(topology => {
                    let text = 'digraph G {\nnode[shape=record];\n';
                    Object.keys(shepherdNodes[req.query.id].devices).forEach(ieeeAddr => {
                        const device = shepherdNodes[req.query.id].devices[ieeeAddr];
                        const labels = [];
                        labels.push(ieeeAddr);
                        labels.push(device.name);
                        labels.push(device.manufName);
                        labels.push(device.modelId);
                        labels.push(device.powerSource);
                        labels.push('overdue=' + device.overdue + ' status=' + device.status);
                        let devStyle;

                        if (device.type === 'Coordinator') {
                            devStyle = 'style="bold"';
                        } else if (device.type === 'Router') {
                            devStyle = 'style="rounded"';
                        } else {
                            devStyle = 'style="rounded, dashed"';
                        }

                        text += `  "${device.ieeeAddr}" [${devStyle}, label="{${labels.join('|')}}"];\n`;

                        topology.filter(e => e.ieeeAddr === device.ieeeAddr).forEach(e => {
                            const lineStyle = (e.lqi === 0) ? 'style="dashed", ' : '';
                            text += `  "${device.ieeeAddr}" -> "${e.parent}" [` + lineStyle + `label="${e.lqi}"]\n`;
                        });
                    });
                    text += '}';
                    res.status(200).send(text.replace(/\0/g, ''));
                });
        } else {
            res.status(500).send('');
        }
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

            this.setMaxListeners(1000);

            this.shepherdNode = shepherdNode;
            this.shepherd = shepherdNode.shepherd;
            this.devices = shepherdNode.devices;

            this.queueMaxWait = 5000;
            this.queueMaxLength = 50;
            this.queuePause = 100;
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
                        if (cmd.cfg && cmd.cfg.disDefaultRsp) {
                            endpoint[cmd.cmdType](cmd.cid, cmd.cmd, cmd.zclData, cmd.cfg);
                            setTimeout(() => {
                                this.cmdPending = false;
                                this.shiftQueue();
                            }, this.queuePause);
                        } else {
                            const timer = setTimeout(() => {
                                this.warn('timeout ' + cmd.cmdType + ' ' + cmd.ieeeAddr + ' ' + this.devices[cmd.ieeeAddr].name + ' ' + cmd.cid + ' ' + cmd.cmd);
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

                            this.debug(cmd.cmdType + ' ' + cmd.ieeeAddr + ' ' + this.devices[cmd.ieeeAddr].name + ' ' + cmd.cid + ' ' + cmd.cmd + ' ' + JSON.stringify(cmd.zclData) + ' ' + JSON.stringify(cmd.cfg));
                            endpoint[cmd.cmdType](cmd.cid, cmd.cmd, cmd.zclData, cmd.cfg, (err, res) => {
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
                                    this.debug('defaultRsp ' + cmd.cmdType + ' ' + cmd.ieeeAddr + ' ' + this.devices[cmd.ieeeAddr].name + ' ' + cmd.cid + ' ' + cmd.cmd + ' ' + JSON.stringify(res));
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

        readyHandler() {
            this.log('ready');
            this.list();
            const now = (new Date()).getTime();

            let currentIndex = 1;

            this.log(`Currently ${Object.keys(this.devices).length} devices are joined:`);
            Object.keys(this.devices).forEach(ieeeAddr => {
                const dev = this.devices[ieeeAddr];

                this.log(`${ieeeAddr} ${dev.name} ${dev.manufName} ${dev.modelId} ${dev.type}`);
                this.devices[ieeeAddr].ts = now;
                delete this.devices[ieeeAddr].overdue;


                const epFirst = this.shepherd.find(ieeeAddr, dev.epList[0]);
                const desc = epFirst.getSimpleDesc();
                const type = zllDevice[desc.devId];
                if (type && dev.modelId !== 'lumi.router') {
                    this.lightsInternal[currentIndex] = {ieeeAddr};

                    const uniqueid = ieeeAddr.replace('0x', '').replace(/([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/, '$1:$2:$3:$4:$5:$6:$7:$8') + '-' + (uniqueidSuffix[dev.manufName] || '00');

                    this.lights[String(currentIndex)] = {
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
                    currentIndex += 1;
                }
            });

            this.proxy.emit('ready');
            this.proxy.emit('nodeStatus', {fill: 'green', shape: 'dot', text: 'connected'});
            this.shepherd.controller.request('UTIL', 'ledControl', {ledid: 3, mode: this.led === 'enabled' ? 1 : 0});
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

        errorHandler(error) {
            this.error(error);
            //this.proxy.emit('error', error);
        }

        indHandler(msg) {
            const now = (new Date()).getTime();
            let ieeeAddr;

            if (msg.type === 'devIncoming' || msg.type === 'devLeaving') {
                ieeeAddr = msg.data;
                this.log(msg.type + ' ' + msg.data);
                this.list();
            } else {
                const firstEp = (msg && msg.endpoints && msg.endpoints[0]) || {};
                ieeeAddr = firstEp.device && firstEp.device.ieeeAddr;
                this.debug(msg.type + ' ' + ieeeAddr + ' ' + (this.devices[ieeeAddr] && this.devices[ieeeAddr].name) + ' ' + JSON.stringify(msg.data));
            }

            if (this.devices[ieeeAddr]) {
                this.devices[ieeeAddr].ts = now;
                if (this.devices[ieeeAddr].overdue !== false) {
                    const timeout = interval[this.devices[ieeeAddr].modelId];
                    if (timeout) {
                        this.debug('overdue false ' + ieeeAddr + ' ' + this.devices[ieeeAddr].name);
                        this.devices[ieeeAddr].overdue = false;
                    }

                    this.proxy.emit('devices', this.devices);
                }
            }

            this.proxy.emit('ind', msg);
            this.indLightHandler(msg);
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

                if (!dev.epDesc) {
                    change = true;
                    dev.epDesc = [];
                    dev.epList.forEach(epId => {
                        const ep = this.shepherd.find(dev.ieeeAddr, epId);
                        const desc = ep.getSimpleDesc();
                        dev.epDesc.push(desc);
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

        bind(deviceSrc, epSrc, deviceDest, epDest, groupDest, cluster) {
            const endpointSrc = this.shepherd.find(deviceSrc, epSrc);
            if (!endpointSrc) {
                this.error('bind source endpoint ' + deviceSrc + ' ' + epSrc + ' unknown');
                return;
            }

            const endpointDest = Number(groupDest) || this.shepherd.find(deviceDest, epDest);
            if (!endpointDest) {
                this.error('bind destination endpoint ' + deviceDest + ' ' + epDest + ' unknown');
                return;
            }

            endpointSrc.bind(cluster, endpointDest, err => {
                if (err) {
                    this.error(err.message);
                } else {
                    this.log('bind ' + deviceSrc + ' from ' + deviceDest + ' successful');
                }
            });
        }

        unbind(deviceSrc, epSrc, deviceDest, epDest, groupDest, cluster) {
            //console.log('unbind', deviceSrc, epSrc, deviceDest, epDest, groupDest, cluster);
            const endpointSrc = this.shepherd.find(deviceSrc, epSrc);
            if (!endpointSrc) {
                this.error('unbind source endpoint ' + deviceSrc + ' ' + epSrc + ' unknown');
                return;
            }

            const endpointDest = Number(groupDest) || this.shepherd.find(deviceDest, epDest);
            if (!endpointDest) {
                this.error('unbind destination endpoint ' + deviceDest + ' ' + epDest + ' unknown');
                return;
            }

            endpointSrc.unbind(cluster, endpointDest, err => {
                if (err) {
                    this.error(err.message);
                } else {
                    this.log('unbind ' + deviceSrc + ' from ' + deviceDest + ' successful');
                }
            });
        }

        checkOverdue() {
            const now = (new Date()).getTime();
            let change = false;
            Object.keys(this.devices).forEach(ieeeAddr => {
                const elapsed = Math.round((now - this.devices[ieeeAddr]) / 60000);
                const timeout = interval[this.devices[ieeeAddr].modelId];
                if (timeout && (elapsed > timeout) && (this.devices[ieeeAddr].overdue !== true)) {
                    change = true;
                    this.info('overdue true ' + ieeeAddr + ' ' + this.devices[ieeeAddr].name);
                    this.devices[ieeeAddr].overdue = true;
                }
            });
            if (change) {
                this.proxy.emit('devices', this.devices);
            }
        }

        indLightHandler(msg) {
            let ieeeAddr;
            let index;

            switch (msg.type) {
                case 'devChange':
                case 'devStatus':
                case 'readRsp': {
                    ieeeAddr = msg.endpoints && msg.endpoints[0] && msg.endpoints[0].device && msg.endpoints[0].device.ieeeAddr;
                    index = this.getLightIndex(ieeeAddr);
                    if (!index) {
                        return;
                    }

                    const ziee = msg.endpoints[0].clusters;

                    const state = {
                        on: Boolean(ziee && ziee.genOnOff && ziee.genOnOff.attrs && ziee.genOnOff.attrs.onOff)
                    };

                    if (msg.type === 'devStatus') {
                        state.reachable = msg.data === 'online';
                        this.updateLight(index, {swversion: ziee.genBasic.attrs.swBuildId});
                    }
                    //console.log('clusters', msg.endpoints[0].clusters);

                    if (ziee.genLevelCtrl) {
                        state.bri = ziee.genLevelCtrl.attrs.currentLevel;
                    }

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
                            state.xy = [attrs.currentX, attrs.currentY];
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

                    this.updateLightState(index, state);
                    break;
                }

                case 'devInterview':
                    index = this.getLightIndex(msg.data);
                    break;

                case 'attReport':
                    ieeeAddr = msg.endpoints && msg.endpoints[0] && msg.endpoints[0].device && msg.endpoints[0].device.ieeeAddr;
                    index = this.getLightIndex(ieeeAddr);
                    break;

                default:
            }
        }

        updateLight(lightIndex, data) {
            if (oe.extend(this.lights[lightIndex], data)) {
                this.proxy.emit('updateLight', lightIndex);
            }
        }

        updateLightState(lightIndex, data) {
            if (oe.extend(this.lights[lightIndex].state, data)) {
                this.proxy.emit('updateLightState', lightIndex);
            }
        }

        putLightsState(msg) {
            //console.log('putLightsState', msg);
            // xy > ct > hs
            // on bool
            // bri uint8 1-254
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

            const dev = this.devices[this.lightsInternal[lightIndex].ieeeAddr];

            const cmds = [];

            if (typeof msg.payload.on !== 'undefined' && (msg.payload.on === false || typeof msg.payload.bri === 'undefined')) {
                if (msg.payload.transitiontime) {
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
                            disDefaultRsp: 0
                        },
                        disBlockQueue: true,
                        callback: (err, res) => {
                            this.handlePutLightStateCallback(err, res, lightIndex, msg, ['on', 'bri']);
                        }
                    });
                } else {
                    cmds.push({
                        ieeeAddr: dev.ieeeAddr,
                        ep: dev.epList[0],
                        cmdType: 'functional',
                        cid: 'genOnOff',
                        cmd: msg.payload.on ? 'on' : 'off',
                        zclData: {},
                        cfg: {
                            disDefaultRsp: 0
                        },
                        disBlockQueue: true,
                        callback: (err, res) => {
                            this.handlePutLightStateCallback(err, res, lightIndex, msg, ['on']);
                        }
                    });
                }
            }

            if (typeof msg.payload.bri !== 'undefined') {
                cmds.push({
                    ieeeAddr: dev.ieeeAddr,
                    ep: dev.epList[0],
                    cmdType: 'functional',
                    cid: 'genLevelCtrl',
                    // Todo: clarify - bri 1 sets off?
                    cmd: msg.payload.on === true && msg.payload.bri > 1 ? 'moveToLevelWithOnOff' : 'moveToLevel',
                    zclData: {
                        level: msg.payload.bri,
                        transtime: msg.payload.transitiontime || 0
                    },
                    cfg: {
                        disDefaultRsp: 0
                    },
                    disBlockQueue: true,
                    callback: (err, res) => {
                        this.handlePutLightStateCallback(err, res, lightIndex, msg, ['on', 'bri']);
                    }
                });
            } else if (typeof msg.payload.bri_inc !== 'undefined') {
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
                        disDefaultRsp: 0
                    },
                    disBlockQueue: true,
                    callback: (err, res) => {
                        this.handlePutLightStateCallback(err, res, lightIndex, msg, []);
                    }
                });
            }

            if (typeof msg.payload.xy !== 'undefined') {
                cmds.push({
                    ieeeAddr: dev.ieeeAddr,
                    ep: dev.epList[0],
                    cmdType: 'functional',
                    cid: 'lightingColorCtrl',
                    cmd: 'moveToColor',
                    zclData: {
                        // Todo convert values
                        colorx: msg.payload.xy[0],
                        colory: msg.payload.xy[1],
                        transtime: msg.payload.transitiontime || 0
                    },
                    cfg: {
                        disDefaultRsp: 0
                    },
                    disBlockQueue: true,
                    callback: (err, res) => {
                        this.handlePutLightStateCallback(err, res, lightIndex, msg, ['xy']);
                    }
                });
            } else if (typeof msg.payload.xy_inc !== 'undefined') {
                cmds.push({
                    ieeeAddr: dev.ieeeAddr,
                    ep: dev.epList[0],
                    cmdType: 'functional',
                    cid: 'lightingColorCtrl',
                    cmd: 'stepColor',
                    zclData: {
                        // Todo convert values
                        stepx: msg.payload.xy_inc[0],
                        stepy: msg.payload.xy_inc[1],
                        transtime: msg.payload.transitiontime || 0
                    },
                    cfg: {
                        disDefaultRsp: 0
                    },
                    disBlockQueue: true,
                    callback: (err, res) => {
                        this.handlePutLightStateCallback(err, res, lightIndex, msg, []);
                    }
                });
            } else if (typeof msg.payload.ct !== 'undefined') {
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
                        disDefaultRsp: 0
                    },
                    disBlockQueue: true,
                    callback: (err, res) => {
                        this.handlePutLightStateCallback(err, res, lightIndex, msg, ['ct']);
                    }
                });
            } else if (typeof msg.payload.ct_inc !== 'undefined') {
                // Todo - clarify: it seems there is no stepColorTemperature cmd - need to know the current ct value?
            } else if (typeof msg.payload.hue !== 'undefined' && typeof msg.payload.sat !== 'undefined') {
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
                        disDefaultRsp: 0
                    },
                    disBlockQueue: true,
                    callback: (err, res) => {
                        this.handlePutLightStateCallback(err, res, lightIndex, msg, ['hue', 'sat']);
                    }
                });
            } else if (typeof msg.payload.hue === 'undefined') {
                if (typeof msg.payload.sat !== 'undefined') {
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
                            disDefaultRsp: 0
                        },
                        disBlockQueue: true,
                        callback: (err, res) => {
                            this.handlePutLightStateCallback(err, res, lightIndex, msg, ['on']);
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
                cmds.push({
                    ieeeAddr: dev.ieeeAddr,
                    ep: dev.epList[0],
                    cmdType: 'functional',
                    cid: 'lightingColorCtrl',
                    cmd: 'enhancedMoveToHue',
                    zclData: {
                        enhancehue: msg.payload.hue,
                        transtime: msg.payload.transitiontime || 0
                    },
                    cfg: {
                        disDefaultRsp: 0
                    },
                    disBlockQueue: true,
                    callback: (err, res) => {
                        this.handlePutLightStateCallback(err, res, lightIndex, msg, ['hue']);
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
                        disDefaultRsp: 0
                    },
                    disBlockQueue: true,
                    callback: (err, res) => {
                        this.handlePutLightStateCallback(err, res, lightIndex, msg, []);
                    }
                });
            }

            if (typeof msg.payload.effect !== 'undefined') {
                // TODO
            }

            cmds.forEach(cmd => {
                this.proxy.queue(cmd);
            });
        }

        handlePutLightStateCallback(err, res, lightIndex, msg, attributes) {
            if (err) {
                if (err.message.includes('status code: 233')) {
                    this.updateLight(lightIndex, {reachable: false});
                } else {
                    this.readLightState(lightIndex, attributes);
                }
            } else if (msg.payload.transitiontime) {
                setTimeout(() => {
                    this.readLightState(lightIndex, attributes);
                }, (msg.payload.transitiontime * 100) + 1000);
            }
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
    }

    RED.nodes.registerType('zigbee-shepherd', ZigbeeShepherd, {
        credentials: {
            panId: {type: 'text'},
            precfgkey: {type: 'text'}
        }
    });
};
