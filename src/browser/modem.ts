

/**
 * A modem via UART, like https://github.com/ewiger/jsmodem
 * Not particlarly useful for anything, superseded by network.js
 */
export class ModemAdapter
{
    private enabled = true;
    private socket = new WebSocket("ws://localhost:2080");
    private opened = false;

    constructor()
    {
        this.socket.onopen = this.onopen.bind(this);;
        this.socket.onmessage = this.onmessage.bind(this);
        this.socket.onclose = this.onclose.bind(this);
        this.socket.onerror = this.onerror.bind(this);
    }

    public send_char()
    {}

    public onmessage(e)
    {
        console.log("onmessage", e);
    };

    public onclose(e)
    {
        console.log("onclose", e);
        this.opened = false;
    };

    public onopen(e)
    {
        console.log("open", e);
        this.opened = true;
    };

    public onerror(e)
    {
        console.log("onerror", e);
    };

    public init(code_fn)
    {
        this.destroy();
        this.send_char = code_fn;
    };

    public destroy()
    {
    };

    public put_chr(chr)
    {
        console.log("put_chr", chr);
        if(this.opened)
        {
            this.socket.send(chr);
        }
    }
}