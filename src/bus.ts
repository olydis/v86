import { dbg_assert } from "./log";

export class BusConnector
{
    private listeners: any;
    public pair: any;

    constructor()
    {
        this.listeners = {};
        this.pair = undefined;
    }

    public register(name: string, fn /*fnc*/, this_value: any): void
    {
        var listeners = this.listeners[name];

        if(listeners === undefined)
        {
            listeners = this.listeners[name] = [];
        }

        listeners.push({
            fn: fn,
            this_value: this_value,
        });
    }

    /**
     * Unregister one message with the given name and callback
     */
    public unregister(name: string, fn /*fnc*/): void
    {
        var listeners = this.listeners[name];

        if(listeners === undefined)
        {
            return;
        }

        this.listeners[name] = listeners.filter((l) =>
        {
            return l.fn !== fn
        });
    }

    /**
     * Send ("emit") a message
     */
    public send(name: string, value?, unused_transfer?): void
    {
        if(!this.pair)
        {
            return;
        }

        var listeners = this.pair.listeners[name];

        if(listeners === undefined)
        {
            return;
        }

        for(var i = 0; i < listeners.length; i++)
        {
            var listener = listeners[i];
            listener.fn.call(listener.this_value, value);
        }
    }

    /**
     * Send a message, guaranteeing that it is received asynchronously
     */
    public send_async(name: string, value: any): void
    {
        dbg_assert(arguments.length === 1 || arguments.length === 2);

        setTimeout(this.send.bind(this, name, value), 0);
    }
}

export class Bus
{
    public static create = () =>
    {
        var c0 = new BusConnector();
        var c1 = new BusConnector();

        c0.pair = c1;
        c1.pair = c0;

        return [c0, c1];
    }
}