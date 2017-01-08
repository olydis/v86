import { BusConnector } from "../bus";
import { dbg_log, dbg_assert } from "../log";

export class SerialAdapter
{
    private enabled = true;
    private text = "";
    private text_new_line = false;
    private last_update = 0;

    private update_timer: number;

    constructor(private element, private bus: BusConnector)
    {
        var serial = this;
        this.bus.register("serial0-output-char", (chr) => this.show_char(chr), this);
        this.init();
    }

    public destroy()
    {
        this.element.removeEventListener("keypress", (e) => this.keypress_handler(e), false);
        this.element.removeEventListener("keydown", (e) => this.keydown_handler(e), false);
        this.element.removeEventListener("paste", (e) => this.paste_handler(e), false);
        window.removeEventListener("mousedown", (e) => this.window_click_handler(e), false);
    }

    public init()
    {
        this.destroy();

        this.element.addEventListener("keypress", (e) => this.keypress_handler(e), false);
        this.element.addEventListener("keydown", (e) => this.keydown_handler(e), false);
        this.element.addEventListener("paste", (e) => this.paste_handler(e), false);
        window.addEventListener("mousedown", (e) => this.window_click_handler(e), false);
    }

    public show_char(chr)
    {
        if(chr === "\x08")
        {
            this.text = this.text.slice(0, -1);
            this.update();
        }
        else if(chr === "\r")
        {
            // do nothing
        }
        else
        {
            this.text += chr;

            if(chr === "\n")
            {
                this.text_new_line = true;
            }

            this.update();
        }
    }

    public update()
    {
        var now = Date.now();
        var delta = now - this.last_update;

        if(delta < 16)
        {
            if(this.update_timer === undefined)
            {
                this.update_timer = setTimeout(() => {
                    this.update_timer = undefined;
                    var now = Date.now();
                    dbg_assert(now - this.last_update >= 16);
                    this.last_update = now;
                    this.render();
                }, 16 - delta);
            }
        }
        else
        {
            if(this.update_timer !== undefined)
            {
                clearTimeout(this.update_timer);
                this.update_timer = undefined;
            }

            this.last_update = now;
            this.render();
        }
    }

    public render()
    {
        this.element.value = this.text;

        if(this.text_new_line)
        {
            this.text_new_line = false;
            this.element.scrollTop = 1e9;
        }
    }

    public send_char(chr_code: number)
    {
        if(this.bus)
        {
            this.bus.send("serial0-input", chr_code);
        }
    }

    public may_handle(e)
    {
        if(!this.enabled)
        {
            return false;
        }

        // Something here?

        return true;
    }

    public keypress_handler(e)
    {
        if(!this.bus)
        {
            return;
        }
        if(!this.may_handle(e))
        {
            return;
        }

        var chr = e.which;

        this.send_char(chr);
        e.preventDefault();
    }

    public keydown_handler(e)
    {
        var chr = e.which;

        if(chr === 8)
        {
            // supress backspace
            this.send_char(127);
            e.preventDefault();
        }
        else if(chr === 9)
        {
            // tab
            this.send_char(9);
            e.preventDefault();
        }
    }

    public paste_handler(e)
    {
        if(!this.may_handle(e))
        {
            return;
        }

        var data = e.clipboardData.getData("text/plain");

        for(var i = 0; i < data.length; i++)
        {
            this.send_char(data.charCodeAt(i));
        }

        e.preventDefault();
    }

    public window_click_handler(e)
    {
        if(e.target !== this.element)
        {
            this.element.blur();
        }
    }
}