module.exports = function (RED) {
    class ZigbeeCommand {
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
                shepherdNode.proxy.queue(msg.payload, (err, res) => {
                    if (err) {
                        this.error(err);
                        this.status({fill: 'red', shape: 'dot', text: err});
                    } else {
                        this.send({topic: msg.topic, payload: res});
                        this.status(nodeStatus);
                    }
                });
            });
        }
    }

    RED.nodes.registerType('zigbee-command', ZigbeeCommand);
};
