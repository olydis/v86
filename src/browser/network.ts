import { BusConnector } from "../bus";
/**
 * An ethernet-through-websocket adapter, to be used with
 *     https://github.com/benjamincburns/websockproxy
 *
 * emulated ethernet card <--> this <--> websocket proxy <--> network
 */
export class NetworkAdapter
{
    private socket = undefined;

    // TODO: circular buffer?
    private send_queue = [];

    private reconnect_interval = 10000;
    private last_connect_attempt = Date.now() - this.reconnect_interval;
    private send_queue_limit = 64;

    constructor(private url: string, private bus: BusConnector)
    {
        this.bus.register("net0-send", (data) =>
        {
            this.send(data);
        }, this);
    }

    public send_data(x) {}

    public handle_message(e)
    {
        if(this.bus)
        {
            this.bus.send("net0-receive", new Uint8Array(e.data));
        }
    };

    public handle_close(e)
    {
        //console.log("onclose", e);

        this.connect();
        setTimeout(() => this.connect(), this.reconnect_interval);
    };

    public handle_open(e)
    {
        //console.log("open", e);

        for(var i = 0; i < this.send_queue.length; i++)
        {
            this.send(this.send_queue[i]);
        }

        this.send_queue = [];
    };

    public handle_error(e)
    {
        //console.log("onerror", e);
    };

    public destroy()
    {
        if(this.socket)
        {
            this.socket.close();
        }
    };

    public connect()
    {
        if(this.socket)
        {
            var state = this.socket.readyState;

            if(state === 0 || state === 1)
            {
                // already or almost there
                return;
            }
        }

        var now = Date.now();

        if(this.last_connect_attempt + this.reconnect_interval > now)
        {
            return;
        }

        this.last_connect_attempt = Date.now();

        try
        {
            this.socket = new WebSocket(this.url);
        }
        catch(e)
        {
            this.handle_close(undefined);
            return;
        }

        this.socket.binaryType = "arraybuffer";

        this.socket.onopen = (e) => this.handle_open(e);
        this.socket.onmessage = (e) => this.handle_message(e);
        this.socket.onclose = (e) => this.handle_close(e);
        this.socket.onerror = (e) => this.handle_error(e);
    };

    public send(data)
    {
        //console.log("send", data);

        if(!this.socket || this.socket.readyState !== 1)
        {
            this.send_queue.push(data);

            if(this.send_queue.length > 2 * this.send_queue_limit)
            {
                this.send_queue = this.send_queue.slice(-this.send_queue_limit);
            }

            this.connect();
        }
        else
        {
            this.socket.send(data);
        }
    }
}