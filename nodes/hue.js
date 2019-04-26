module.exports = function (RED) {
    class ZigbeeHue {
        constructor(config) {
            RED.nodes.createNode(this, config);

            const shepherdNode = RED.nodes.getNode(config.shepherd);

            if (!shepherdNode) {
                this.error('missing shepherd');
                return;
            }

            this.devices = shepherdNode.devices;
            this.shepherd = shepherdNode.shepherd;
            this.proxy = shepherdNode.proxy;

            let nodeStatus;
            shepherdNode.proxy.on('nodeStatus', status => {
                nodeStatus = status;
                this.status(status);
            });

            this.lights = shepherdNode.lights;
            this.lightsInternal = shepherdNode.lightsInternal;

            this.on('input', msg => {
                console.log('input!');
                let match;
                if (msg.topic.match(/lights$/)) {
                    this.send(Object.assign(RED.util.cloneMessage(msg), {payload: this.lights}));
                } else if (match = msg.topic.match(/lights\/([^\/]+)$/)) {
                    const [, index] = match;
                    const id = shepherdNode.getLightIndex(index);
                    if (id) {
                        this.send(Object.assign(RED.util.cloneMessage(msg), {payload: this.lights[index]}));
                    } else {
                        this.send(Object.assign(RED.util.cloneMessage(msg), {payload: this.apiError(3, {resource: '/lights/' + index})}));
                    }
                } else if (match = msg.topic.match(/lights\/([^\/]+)\/state$/)) {
                    const [, index] = match;
                    shepherdNode.putLightsState(msg);
                }
            });

            this.on('close', () => {

            });
        }

        apiError(id, data) {
            switch (id) {
                case 3:
                    return [
                        {
                            error: {
                                type: 3,
                                address: data.resource,
                                description: 'resource, ' + data.resource + ', not available'
                            }
                        }
                    ];
                default:
            }
        }

        getLights() {

        }
    }

    RED.nodes.registerType('zigbee-hue', ZigbeeHue);
};
