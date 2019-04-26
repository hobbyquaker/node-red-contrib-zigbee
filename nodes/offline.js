module.exports = function (RED) {
    class ZigbeeOffline {
        constructor(config) {
            RED.nodes.createNode(this, config);

            const shepherdNode = RED.nodes.getNode(config.shepherd);

            if (!shepherdNode) {
                this.error('missing shepherd');
                return;
            }

            const nodeStatusHandler = status => {
                this.status(status);
            };

            this.shepherdNode = shepherdNode;
            this.shepherd = shepherdNode.shepherd;
            this.topic = config.topic;

            this.state = {};

            const devicesHandler = () => {
                this.checkState();
            };

            const readyHandler = () => {
                this.checkState();
            };

            shepherdNode.proxy.on('nodeStatus', nodeStatusHandler);
            shepherdNode.proxy.on('devices', devicesHandler);
            shepherdNode.proxy.on('ready', readyHandler);

            this.on('close', () => {
                shepherdNode.proxy.removeListener('nodeStatus', nodeStatusHandler);
                shepherdNode.proxy.removeListener('devices', devicesHandler);
                shepherdNode.proxy.removeListener('ready', readyHandler);
            });
        }

        checkState() {
            /console.log('offline: checkState!');
            Object.keys(this.shepherdNode.devices).forEach(ieeeAddr => {
                const {overdue} = this.shepherdNode.devices[ieeeAddr];
                const offline = this.shepherdNode.devices[ieeeAddr].status === 'offline';
                if (!this.state[ieeeAddr]) {
                    this.state[ieeeAddr] = {};
                }

                if (this.state[ieeeAddr].overdue !== overdue || this.state[ieeeAddr].offline !== offline) {
                    const payload = this.shepherdNode.devices[ieeeAddr].powerSource === 'Battery' ? overdue : offline;
                    if (typeof payload !== 'boolean') {
                        return;
                    }

                    const msg = {
                        topic: null,
                        payload,
                        retain: true,
                        ieeeAddr,
                        name: this.shepherdNode.devices[ieeeAddr].name
                    };
                    //console.log('offline', msg.name, msg.payload);
                    msg.topic = this.topicReplace(this.topic, msg);
                    this.send(msg);
                }

                this.state[ieeeAddr].overdue = overdue;
                this.state[ieeeAddr].offline = offline;
            });
        }

        topicReplace(topic, msg) {
            if (!topic || typeof msg !== 'object') {
                return topic;
            }

            const msgLower = {};
            Object.keys(msg).forEach(k => {
                msgLower[k.toLowerCase()] = msg[k];
            });

            const match = topic.match(/\${[^}]+}/g);
            if (match) {
                match.forEach(v => {
                    const key = v.substr(2, v.length - 3);
                    const rx = new RegExp('\\${' + key + '}', 'g');
                    const rkey = key.toLowerCase();
                    topic = topic.replace(rx, msgLower[rkey] || '');
                });
            }

            return topic;
        }
    }

    RED.nodes.registerType('zigbee-offline', ZigbeeOffline);
};
