module.exports = {
    zllDevice: {
        0x0000: 'On/off light',
        0x0010: 'On/off plug-in unit',
        0x0100: 'Dimmable light',
        0x0101: 'Color temperature light', // LEDVANCE Tunable White
        0x010D: 'Extended color light', // MLI ZBT-ExtendedColor
        0x0110: 'Dimmable plug-in unit',
        0x0200: 'Color light',
        0x0210: 'Extended color light',
        0x0220: 'Color temperature light'
    },
    uniqueidSuffix: {
        OSRAM: '03',
        Philips: '0b'
    },
    emptyStates: {
        'On/off light': {
            on: false,
            reachable: false
        },
        'On/off plug-in unit': {
            on: false,
            reachable: false
        },
        'Dimmable light': {
            on: false,
            bri: 0,
            alert: 'none',
            reachable: false
        },
        'Dimmable plug-in unit': {
            on: false,
            bri: 0,
            alert: 'none',
            reachable: false
        },
        'Color light': {
            on: false,
            bri: 0,
            hue: 0,
            sat: 0,
            effect: 'none',
            xy: [
                0,
                0
            ],
            alert: 'none',
            colormode: 'xy',
            reachable: false
        },
        'Extended color light': {
            on: false,
            bri: 0,
            hue: 0,
            sat: 0,
            effect: 'none',
            xy: [
                0,
                0
            ],
            ct: 370,
            alert: 'none',
            colormode: 'ct',
            reachable: false
        },
        'Color temperature light': {
            on: false,
            bri: 0,
            ct: 370,
            alert: 'none',
            colormode: 'ct',
            reachable: false
        }
    }
};
