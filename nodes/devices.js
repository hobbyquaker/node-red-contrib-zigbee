module.exports = function (RED) {
    class ZigbeeDevices {
        constructor(config) {
            RED.nodes.createNode(this, config);

            const shepherdNode = RED.nodes.getNode(config.shepherd);

            if (!shepherdNode) {
                this.error('missing shepherd');
                return;
            }

            this.proxy = shepherdNode.proxy;

            let nodeStatus;

            this.shepherd = shepherdNode.shepherd;

            this.on('input', msg => {
                let time = parseInt(msg.payload, 10) || 30;
                time = time > 255 ? 255 : time;
                this.shepherd.permitJoin(time);
            });

            const nodeStatusHandler = status => {
                nodeStatus = status;
                this.status(status);
            };

            const devicesHandler = () => {
                this.send([null, {payload: shepherdNode.devices}]);
            };

            const readyHandler = () => {
                this.send([null, {payload: shepherdNode.devices}]);
            };

            const permitJoiningHandler = joinTimeLeft => {
                this.send([{payload: joinTimeLeft}, null]);
                if (joinTimeLeft) {
                    this.status({fill: 'blue', shape: 'ring', text: joinTimeLeft + 's'});
                } else {
                    this.status(nodeStatus);
                }
            };

            this.proxy.on('nodeStatus', nodeStatusHandler);
            this.proxy.on('devices', devicesHandler);
            this.proxy.on('ready', readyHandler);
            this.proxy.on('permitJoining', permitJoiningHandler);

            this.on('close', () => {
                this.proxy.removeListener('nodeStatus', nodeStatusHandler);
                this.proxy.removeListener('devices', devicesHandler);
                this.proxy.removeListener('ready', readyHandler);
                this.proxy.removeListener('permitJoining', permitJoiningHandler);
            });
        }
    }

    RED.nodes.registerType('zigbee-devices', ZigbeeDevices);
};
