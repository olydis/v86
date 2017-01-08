declare class Virtio9p
{
    constructor(filesystem: FS, bus: any);
    public configspace: any[];
    public SendReply: any;
    public ReceiveRequest: any;
    public replybuffersize: number;
    public replybuffer: any[];
}