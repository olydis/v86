declare class FS
{
    constructor(sth: any);

    public CreateBinaryFile(filename: any, parent_id: any, data: any): any;
    public SearchPath(file: any): any;
    public OpenInode(id: any, sth: any): any;
    public AddEvent(id: any, sth: any): any;
    public inodedata: any;
    public inodes: any;
}