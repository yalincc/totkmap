export namespace main {
	
	export class Config {
	    saveDirRyujinx?: string;
	    saveDirEden?: string;
	    emu?: string;
	    tls?: boolean;
	
	    static createFrom(source: any = {}) {
	        return new Config(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.saveDirRyujinx = source["saveDirRyujinx"];
	        this.saveDirEden = source["saveDirEden"];
	        this.emu = source["emu"];
	        this.tls = source["tls"];
	    }
	}

}

