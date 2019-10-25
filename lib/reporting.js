const defaultConfiguration = {minimumReportInterval: 3, maximumReportInterval: 3600, reportableChange: 1};

const clusters = {
    genOnOff: [
        {attribute: 'onOff', ...defaultConfiguration, minimumReportInterval: 0, reportableChange: 0}
    ],
    genLevelCtrl: [
        {attribute: 'currentLevel', ...defaultConfiguration}
    ],
    lightingColorCtrl: [
        {attribute: 'colorTemperature', ...defaultConfiguration},
        {attribute: 'currentX', ...defaultConfiguration},
        {attribute: 'currentY', ...defaultConfiguration},
        {attribute: 'currentSaturation', ...defaultConfiguration},
        {attribute: 'enhancedCurrentHue', ...defaultConfiguration},
        {attribute: 'colorMode', ...defaultConfiguration}
    ],
    closuresWindowCovering: [
        {attribute: 'currentPositionLiftPercentage', ...defaultConfiguration},
        {attribute: 'currentPositionTiltPercentage', ...defaultConfiguration}
    ]
};

const configuring = new Set();

module.exports = {
    async remove(device) {
        if (configuring.has(device.ieeeAddr)) {
            this.warn(`reporting remove ${device.ieeeAddr} ${device.meta.name} - already configuring`);
            return;
        }

        if (device.meta.reportingFails === this.maxConfigureTries) {
            this.warn(`reporting last try ${device.meta.name} ${device.ieeeAddr} after ${device.meta.reportingFails} fails`);
        } else if (device.meta.reportingFails > this.maxConfigureTries) {
            this.debug(`reporting max tries exceeded for ${device.meta.name} ${device.ieeeAddr}`);
            return;
        }

        this.debug(`reporting remove ${device.ieeeAddr} ${device.meta.name} (try ${device.meta.reportingFails})`);

        configuring.add(device.ieeeAddr);
        try {
            for (const endpoint of device.endpoints) {
                for (const [cluster, configuration] of Object.entries(clusters)) {
                    if (endpoint.supportsInputCluster(cluster)) {
                        this.log(`unbind ${device.ieeeAddr} ${endpoint.ID} ${cluster} from coordinator`);
                        await this.unbind(device.ieeeAddr, endpoint.ID, cluster, this.coordinatorEndpoint.deviceIeeeAddress, this.coordinatorEndpoint.ID);
                        await new Promise(resolve => setTimeout(resolve, 3000));
                        const removeConfiguration = configuration.map(c => ({...c, maximumReportInterval: 0, minimumReportInterval: 0xFFFF}));
                        this.log(`configureReporting ${device.ieeeAddr} ${device.meta.name} ${cluster} ${JSON.stringify(removeConfiguration)}`);
                        await endpoint.configureReporting(cluster, removeConfiguration);
                        this.log(`Successfully removed reporting for ${device.ieeeAddr} ${device.meta.name} - ${endpoint.ID} - ${cluster}`);
                    }
                }
            }

            device.meta.reportingFails = 0;
            device.meta.reporting = false;
        } catch (error) {
            device.meta.reportingFails += 1;
            this.error(`Failed to remove reporting for ${device.ieeeAddr} ${device.meta.name} - ${error.message}`);
        }

        await device.save();
        configuring.delete(device.ieeeAddr);
    },
    async setup(device) {
        if (configuring.has(device.ieeeAddr)) {
            this.warn(`reporting setup ${device.ieeeAddr} ${device.meta.name} - already configuring`);
            return;
        }

        if (device.meta.reportingFails === this.maxConfigureTries) {
            this.warn(`reporting last try ${device.meta.name} ${device.ieeeAddr} after ${device.meta.reportingFails + 1} fails`);
        } else if (device.meta.reportingFails > this.maxConfigureTries) {
            this.debug(`reporting max tries exceeded for ${device.meta.name} ${device.ieeeAddr}`);
            return;
        }

        this.debug(`reporting setup ${device.ieeeAddr} ${device.meta.name} (try ${device.meta.reportingFails})`);

        configuring.add(device.ieeeAddr);
        try {
            for (const endpoint of device.endpoints) {
                for (const [cluster, configuration] of Object.entries(clusters)) {
                    if (endpoint.supportsInputCluster(cluster)) {
                        this.log(`bind ${device.ieeeAddr} ${endpoint.ID} ${cluster} to coordinator`);
                        await this.bind(device.ieeeAddr, endpoint.ID, cluster, this.coordinatorEndpoint.deviceIeeeAddress, this.coordinatorEndpoint.ID);
                        await new Promise(resolve => setTimeout(resolve, 3000));
                        this.log(`configureReporting ${device.ieeeAddr} ${device.meta.name} ${cluster} ${JSON.stringify(configuration)}`);
                        await endpoint.configureReporting(cluster, configuration);
                        this.log(`Successfully setup reporting for ${device.ieeeAddr} ${device.meta.name} - ${endpoint.ID} - ${cluster}`);
                    }
                }
            }

            device.meta.reportingFails = 0;
            device.meta.reporting = true;
        } catch (error) {
            device.meta.reportingFails += 1;
            this.error(`Failed to setup reporting for ${device.ieeeAddr} ${device.meta.name} - ${error.message}`);
        }

        await device.save();
        configuring.delete(device.ieeeAddr);
    }
};
