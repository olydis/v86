import { BusConnector } from "../bus";

/** @const */
var SHIFT_SCAN_CODE = 0x2A;

/** @const */
var SCAN_CODE_RELEASE = 0x80;

export class KeyboardAdapter
{
    /**
     * Set by emulator
     */
    public emu_enabled = true;

    private keys_pressed: { [key: number]: boolean };
/**
     * Format:
     * Javascript event.keyCode -> make code
     */
    private readonly charmap = new Uint16Array([
        0, 0, 0, 0,  0, 0, 0, 0,
        // 0x08: backspace, tab, enter
        0x0E, 0x0F, 0, 0,  0, 0x1C, 0, 0,

        // 0x10: shift, ctrl, alt, pause, caps lock
        0x2A, 0x1D, 0x38, 0,  0x3A, 0, 0, 0,

        // 0x18: escape
        0, 0, 0, 0x01,  0, 0, 0, 0,

        // 0x20: spacebar, page down/up, end, home, arrow keys, ins, del
        0x39, 0xE049, 0xE051, 0xE04F,  0xE047, 0xE04B, 0xE048, 0xE04D,
        0x50, 0, 0, 0,  0, 0x52, 0x53, 0,

        // 0x30: numbers
        0x0B, 0x02, 0x03, 0x04,  0x05, 0x06, 0x07, 0x08,
        0x09, 0x0A,

        // 0x3B: ;= (firefox only)
        0, 0x27, 0, 0x0D, 0, 0,

        // 0x40
        0,

        // 0x41: letters
        0x1E, 0x30, 0x2E, 0x20, 0x12, 0x21, 0x22, 0x23, 0x17, 0x24, 0x25, 0x26, 0x32,
        0x31, 0x18, 0x19, 0x10, 0x13, 0x1F, 0x14, 0x16, 0x2F, 0x11, 0x2D, 0x15, 0x2C,

        // 0x5B: Left Win, Right Win, Menu
        0xE05B, 0xE05C, 0xE05D, 0, 0,

        // 0x60: keypad
        0x52, 0x4F, 0x50, 0x51, 0x4B, 0x4C, 0x4D, 0x47,
        0x48, 0x49, 0, 0, 0, 0, 0, 0,

        // 0x70: F1 to F12
        0x3B, 0x3C, 0x3D, 0x3E, 0x3F, 0x40, 0x41, 0x42, 0x43, 0x44, 0x57, 0x58,

        0, 0, 0, 0,

        // 0x80
        0, 0, 0, 0,  0, 0, 0, 0,
        0, 0, 0, 0,  0, 0, 0, 0,

        // 0x90: Numlock
        0x45, 0, 0, 0,  0, 0, 0, 0,
        0, 0, 0, 0,     0, 0, 0, 0,

        // 0xA0: - (firefox only)
        0, 0, 0, 0,  0, 0, 0, 0,
        0, 0, 0, 0,  0, 0x0C, 0, 0,

        // 0xB0
        // ,
        0, 0, 0, 0,  0, 0, 0, 0,
        0, 0, 0x27, 0x0D,  0x33, 0x0C, 0x34, 0x35,

        // 0xC0
        // `
        0x29, 0, 0, 0,  0, 0, 0, 0,
        0, 0, 0, 0,     0, 0, 0, 0,

        // 0xD0
        // [']\
        0, 0, 0, 0,     0, 0, 0, 0,
        0, 0, 0, 0x1A,  0x2B, 0x1B, 0x28, 0,

        // 0xE0
        // Apple key on Gecko, Right alt
        0xE05B, 0xE038, 0, 0,  0, 0, 0, 0,
        0, 0, 0, 0,            0, 0, 0, 0,
    ]);


    /**
     * ascii -> javascript event code (US layout)
     * @const
     */
    private readonly asciimap = {10: 13, 32: 32, 39: 222, 44: 188, 45: 189, 46: 190, 47: 191, 48: 48, 49: 49, 50: 50, 51: 51, 52: 52, 53: 53, 54: 54, 55: 55, 56: 56, 57: 57, 59: 186, 61: 187, 91: 219, 92: 220, 93: 221, 96: 192, 97: 65, 98: 66, 99: 67, 100: 68, 101: 69, 102: 70, 103: 71, 104: 72, 105: 73, 106: 74, 107: 75, 108: 76, 109: 77, 110: 78, 111: 79, 112: 80, 113: 81, 114: 82, 115: 83, 116: 84, 117: 85, 118: 86, 119: 87, 120: 88, 121: 89, 122: 90};
    private readonly asciimap_shift = {33: 49, 34: 222, 35: 51, 36: 52, 37: 53, 38: 55, 40: 57, 41: 48, 42: 56, 43: 187, 58: 186, 60: 188, 62: 190, 63: 191, 64: 50, 65: 65, 66: 66, 67: 67, 68: 68, 69: 69, 70: 70, 71: 71, 72: 72, 73: 73, 74: 74, 75: 75, 76: 76, 77: 77, 78: 78, 79: 79, 80: 80, 81: 81, 82: 82, 83: 83, 84: 84, 85: 85, 86: 86, 87: 87, 88: 88, 89: 89, 90: 90, 94: 54, 95: 189, 123: 219, 124: 220, 125: 221, 126: 192}

    // From:
    // https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/code#Code_values_on_Linux_%28X11%29_%28When_scancode_is_available%29
    // http://stanislavs.org/helppc/make_codes.html
    // http://www.computer-engineering.org/ps2keyboard/scancodes1.html
    //
    // Mapping from event.code to scancode
    private readonly codemap = {
        "Escape": 0x0001,
        "Digit1": 0x0002,
        "Digit2": 0x0003,
        "Digit3": 0x0004,
        "Digit4": 0x0005,
        "Digit5": 0x0006,
        "Digit6": 0x0007,
        "Digit7": 0x0008,
        "Digit8": 0x0009,
        "Digit9": 0x000a,
        "Digit0": 0x000b,
        "Minus": 0x000c,
        "Equal": 0x000d,
        "Backspace": 0x000e,
        "Tab": 0x000f,
        "KeyQ": 0x0010,
        "KeyW": 0x0011,
        "KeyE": 0x0012,
        "KeyR": 0x0013,
        "KeyT": 0x0014,
        "KeyY": 0x0015,
        "KeyU": 0x0016,
        "KeyI": 0x0017,
        "KeyO": 0x0018,
        "KeyP": 0x0019,
        "BracketLeft": 0x001a,
        "BracketRight": 0x001b,
        "Enter": 0x001c,
        "ControlLeft": 0x001d,
        "KeyA": 0x001e,
        "KeyS": 0x001f,
        "KeyD": 0x0020,
        "KeyF": 0x0021,
        "KeyG": 0x0022,
        "KeyH": 0x0023,
        "KeyJ": 0x0024,
        "KeyK": 0x0025,
        "KeyL": 0x0026,
        "Semicolon": 0x0027,
        "Quote": 0x0028,
        "Backquote": 0x0029,
        "ShiftLeft": 0x002a,
        "Backslash": 0x002b,
        "KeyZ": 0x002c,
        "KeyX": 0x002d,
        "KeyC": 0x002e,
        "KeyV": 0x002f,
        "KeyB": 0x0030,
        "KeyN": 0x0031,
        "KeyM": 0x0032,
        "Comma": 0x0033,
        "Period": 0x0034,
        "Slash": 0x0035,
        "ShiftRight": 0x0036,
        "NumpadMultiply": 0x0037,
        "AltLeft": 0x0038,
        "Space": 0x0039,
        "CapsLock": 0x003a,
        "F1": 0x003b,
        "F2": 0x003c,
        "F3": 0x003d,
        "F4": 0x003e,
        "F5": 0x003f,
        "F6": 0x0040,
        "F7": 0x0041,
        "F8": 0x0042,
        "F9": 0x0043,
        "F10": 0x0044,
        "NumLock": 0x0045,
        "ScrollLock": 0x0046,
        "Numpad7": 0x0047,
        "Numpad8": 0x0048,
        "Numpad9": 0x0049,
        "NumpadSubtract": 0x004a,
        "Numpad4": 0x004b,
        "Numpad5": 0x004c,
        "Numpad6": 0x004d,
        "NumpadAdd": 0x004e,
        "Numpad1": 0x004f,
        "Numpad2": 0x0050,
        "Numpad3": 0x0051,
        "Numpad0": 0x0052,
        "NumpadDecimal": 0x0053,
        "IntlBackslash": 0x0056,
        "F11": 0x0057,
        "F12": 0x0058,

        "NumpadEnter": 0xe01c,
        "ControlRight": 0xe01d,
        "NumpadDivide": 0xe035,
        //"PrintScreen": 0x0063,
        "AltRight": 0xe038,
        "Home": 0xe04f,
        "ArrowUp": 0xe048,
        "PageUp": 0xe049,
        "ArrowLeft": 0xe04b,
        "ArrowRight": 0xe04d,
        "End": 0xe04f,
        "ArrowDown": 0xe050,
        "PageDown": 0xe051,
        "Insert": 0xe052,
        "Delete": 0xe053,

        "OSLeft": 0xe05b,
        "OSRight": 0xe05c,
        "ContextMenu": 0xe05d,
    };

    constructor(private bus: BusConnector)
    {
        this.init();
    }

    public destroy()
    {
        if(typeof window !== "undefined")
        {
            window.removeEventListener("keyup", this.keyup_handler, false);
            window.removeEventListener("keydown", this.keydown_handler, false);
            window.removeEventListener("blur", this.blur_handler, false);
        }
    }

    public init()
    {
        if(typeof window === "undefined")
        {
            return;
        }
        this.destroy();

        window.addEventListener("keyup", this.keyup_handler, false);
        window.addEventListener("keydown", this.keydown_handler, false);
        window.addEventListener("blur", this.blur_handler, false);
    }

    public simulate_press(code)
    {
        var ev = { keyCode: code };
        this.handler(ev, true);
        this.handler(ev, false);
    }

    public simulate_char(chr)
    {
        var code = chr.charCodeAt(0);

        if(code in this.asciimap)
        {
            this.simulate_press(this.asciimap[code]);
        }
        else if(code in this.asciimap_shift)
        {
            this.send_to_controller(SHIFT_SCAN_CODE);
            this.simulate_press(this.asciimap_shift[code]);
            this.send_to_controller(SHIFT_SCAN_CODE | SCAN_CODE_RELEASE);
        }
        else
        {
            console.log("ascii -> keyCode not found: ", code, chr);
        }
    }

    public may_handle(e)
    {
        if(e.shiftKey && e.ctrlKey && e.keyCode === 74)
        {
            // don't prevent opening chromium dev tools
            // maybe add other important combinations here, too
            return false;
        }

        if(!this.emu_enabled)
        {
            return false;
        }

        if(e.target)
        {
            // className shouldn't be hardcoded here
            return e.target.className === "phone_keyboard" ||
                (e.target.nodeName !== "INPUT" && e.target.nodeName !== "TEXTAREA");
        }
        else
        {
            return true;
        }
    }

    public translate(e)
    {
        if(e.code !== undefined)
        {
            var code = this.codemap[e.code];

            if(code !== undefined)
            {
                return code;
            }
        }

        return this.charmap[e.keyCode];
    }

    public keyup_handler(e)
    {
        return this.handler(e, false);
    }

    public keydown_handler(e)
    {
        return this.handler(e, true);
    }

    public blur_handler(e)
    {
        // trigger keyup for all pressed keys
        var keys = Object.keys(this.keys_pressed),
            key;

        for(var i = 0; i < keys.length; i++)
        {
            key = +keys[i];

            if(this.keys_pressed[key])
            {
                this.handle_code(key, false);
            }
        }

        this.keys_pressed = {};
    }

    /**
     * @param {boolean} keydown
     */
    public handler(e, keydown)
    {
        if(!this.bus)
        {
            return undefined;
        }

        if(!this.may_handle(e))
        {
            return undefined;
        }

        var code = this.translate(e);

        if(!code)
        {
            console.log("Missing char in map: " + e.keyCode.toString(16));
            return undefined;
        }

        this.handle_code(code, keydown);

        e.preventDefault && e.preventDefault();

        return false;
    }

    /**
     * @param {number} code
     * @param {boolean} keydown
     */
    public handle_code(code, keydown)
    {
        if(keydown)
        {
            if(this.keys_pressed[code])
            {
                this.handle_code(code, false);
            }
        }
        else
        {
            if(!this.keys_pressed[code])
            {
                // stray keyup
                return;
            }
        }

        this.keys_pressed[code] = keydown;

        if(!keydown)
        {
            code |= 0x80;
        }
        //console.log("Key: " + code.toString(16) + " from " + chr.toString(16) + " down=" + keydown);

        if(code > 0xFF)
        {
            // prefix
            this.send_to_controller(code >> 8);
            this.send_to_controller(code & 0xFF);
        }
        else
        {
            this.send_to_controller(code);
        }
    }

    public send_to_controller(code)
    {
        this.bus.send("keyboard-code", code);
    }
}