export namespace main {
	
	export class Config {
	    saveDirRyujinx?: string;
	    saveDirEden?: string;
	    emu?: string;
	    tls?: boolean;
	    autoOpenMap?: boolean;
	    diagUrl?: string;
	    customProc?: string;
	    profile?: string;
	
	    static createFrom(source: any = {}) {
	        return new Config(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.saveDirRyujinx = source["saveDirRyujinx"];
	        this.saveDirEden = source["saveDirEden"];
	        this.emu = source["emu"];
	        this.tls = source["tls"];
	        this.autoOpenMap = source["autoOpenMap"];
	        this.diagUrl = source["diagUrl"];
	        this.customProc = source["customProc"];
	        this.profile = source["profile"];
	    }
	}
	export class ProcessItem {
	    pid: number;
	    name: string;
	    memMB: number;
	
	    static createFrom(source: any = {}) {
	        return new ProcessItem(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.pid = source["pid"];
	        this.name = source["name"];
	        this.memMB = source["memMB"];
	    }
	}

}

