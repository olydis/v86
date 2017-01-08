import { BusConnector } from "../bus";

export class MouseAdapter
{
    private readonly SPEED_FACTOR = 0.15;

    private left_down = false;
    private right_down = false;
    private middle_down = false;

    private last_x = 0;
    private last_y = 0;

    private mouse = this;

    // set by controller
    private enabled = false;

    // set by emulator
    public emu_enabled = true;

    constructor(private bus: BusConnector, screen_container)
    {
        this.bus.register("mouse-enable", (enabled) =>
        {
            this.enabled = enabled;
        }, this);

        this.init();
    }

    public destroy()
    {
        window.removeEventListener("touchstart", this.touch_start_handler, false);
        window.removeEventListener("touchend", this.touch_end_handler, false);
        window.removeEventListener("touchmove", this.mousemove_handler, false);
        window.removeEventListener("mousemove", this.mousemove_handler, false);
        window.removeEventListener("mousedown", this.mousedown_handler, false);
        window.removeEventListener("mouseup", this.mouseup_handler, false);
        window.removeEventListener("DOMMouseScroll", this.mousewheel_handler, false);
        window.removeEventListener("mousewheel", this.mousewheel_handler, false);
    }

    public init()
    {
        if(typeof window === "undefined")
        {
            return;
        }
        this.destroy();

        window.addEventListener("touchstart", this.touch_start_handler, false);
        window.addEventListener("touchend", this.touch_end_handler, false);
        window.addEventListener("touchmove", this.mousemove_handler, false);
        window.addEventListener("mousemove", this.mousemove_handler, false);
        window.addEventListener("mousedown", this.mousedown_handler, false);
        window.addEventListener("mouseup", this.mouseup_handler, false);
        window.addEventListener("DOMMouseScroll", this.mousewheel_handler, false);
        window.addEventListener("mousewheel", this.mousewheel_handler, false);
    }

    public is_child(child, parent)
    {
        while(child.parentNode)
        {
            if(child === parent)
            {
                return true;
            }
            child = child.parentNode;
        }

        return false;
    }

    public may_handle(e)
    {
        if(!this.mouse.enabled || !this.mouse.emu_enabled)
        {
            return false;
        }

        if(e.type === "mousemove" || e.type === "touchmove")
        {
            return true;
        }

        if(e.type === "mousewheel" || e.type === "DOMMouseScroll")
        {
            var parent = document.body;
            return this.is_child(e.target, parent);
        }

        return !e.target || e.target.nodeName !== "INPUT" && e.target.nodeName !== "TEXTAREA";
    }

    public touch_start_handler(e)
    {
        if(this.may_handle(e))
        {
            var touches = e["changedTouches"];

            if(touches && touches.length)
            {
                var touch = touches[touches.length - 1];
                this.last_x = touch.clientX;
                this.last_y = touch.clientY;
            }
        }
    }

    public touch_end_handler(e)
    {
        if(this.left_down || this.middle_down || this.right_down)
        {
            this.mouse.bus.send("mouse-click", [false, false, false]);
            this.left_down = this.middle_down = this.right_down = false;
        }
    }

    public mousemove_handler(e)
    {
        if(!this.mouse.bus)
        {
            return;
        }

        if(!this.may_handle(e))
        {
            return;
        }

        var delta_x = 0;
        var delta_y = 0;

        var touches = e["changedTouches"];

        if(touches)
        {
            if(touches.length)
            {
                var touch = touches[touches.length - 1];
                delta_x = touch.clientX - this.last_x;
                delta_y = touch.clientY - this.last_y;

                this.last_x = touch.clientX;
                this.last_y = touch.clientY;

                e.preventDefault();
            }
        }
        else
        {
            if(typeof e["movementX"] === "number")
            {
                delta_x = e["movementX"];
                delta_y = e["movementY"];
            }
            else if(typeof e["webkitMovementX"] === "number")
            {
                delta_x = e["webkitMovementX"];
                delta_y = e["webkitMovementY"];
            }
            else if(typeof e["mozMovementX"] === "number")
            {
                delta_x = e["mozMovementX"];
                delta_y = e["mozMovementY"];
            }
            else
            {
                // Fallback for other browsers?
                delta_x = e.clientX - this.last_x;
                delta_y = e.clientY - this.last_y;

                this.last_x = e.clientX;
                this.last_y = e.clientY;
            }
        }

        if(this.SPEED_FACTOR !== 1 as number)
        {
            delta_x = delta_x * this.SPEED_FACTOR;
            delta_y = delta_y * this.SPEED_FACTOR;
        }

        //if(Math.abs(delta_x) > 100 || Math.abs(delta_y) > 100)
        //{
        //    // Large mouse delta, drop?
        //}

        delta_y = -delta_y;

        this.mouse.bus.send("mouse-delta", [delta_x, delta_y]);
    }

    public mousedown_handler(e)
    {
        if(this.may_handle(e))
        {
            this.click_event(e, true);
        }
    }

    public mouseup_handler(e)
    {
        if(this.may_handle(e))
        {
            this.click_event(e, false);
        }
    }

    public click_event(e, down)
    {
        if(!this.mouse.bus)
        {
            return;
        }

        if(e.which === 1)
        {
            this.left_down = down;
        }
        else if(e.which === 2)
        {
            this.middle_down = down;
        }
        else if(e.which === 3)
        {
            this.right_down = down;
        }
        else
        {
            console.log("Unknown event.which: " + e.which);
        }
        this.mouse.bus.send("mouse-click", [this.left_down, this.middle_down, this.right_down]);
    }

    public mousewheel_handler(e)
    {
        if(!this.may_handle(e))
        {
            return;
        }

        var delta_x = e.wheelDelta || -e.detail;
        var delta_y = 0;

        if(delta_x < 0)
        {
            delta_x = -1;
        }
        else if(delta_x > 0)
        {
            delta_x = 1;
        }

        this.mouse.bus.send("mouse-wheel", [delta_x, delta_y]);
        e.preventDefault();
    }
}