module.exports = function (RED) {
    class ZigbeeDevices {
        constructor(config) {
            RED.nodes.createNode(this, config);

            const shepherdNode = RED.nodes.getNode(config.shepherd);

            if (!shepherdNode) {
                this.error('missing shepherd');
                return;
            }

            let nodeStatus;

            shepherdNode.proxy.on('nodeStatus', status => {
                nodeStatus = status;
                this.status(status);
            });

            this.shepherd = shepherdNode.shepherd;

            this.on('input', msg => {
                let time = parseInt(msg.payload, 10) || 30;
                time = time > 255 ? 255 : time;
                this.shepherd.permitJoin(time);
            });

            this.shepherd.on('ready', () => {
                this.send([null, {payload: shepherdNode.devices}]);
            });

            this.shepherd.on('permitJoining', joinTimeLeft => {
                this.send([{payload: joinTimeLeft}, null]);
                if (joinTimeLeft) {
                    this.status({fill: 'blue', shape: 'ring', text: joinTimeLeft + 's'});
                } else {
                    this.status(nodeStatus);
                }
            });
        }
    }

    RED.nodes.registerType('zigbee-devices', ZigbeeDevices);
};
