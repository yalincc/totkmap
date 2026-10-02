export namespace main {
	
	export class Config {
	    ryujinxDir: string;
	    saveDir: string;
	
	    static createFrom(source: any = {}) {
	        return new Config(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.ryujinxDir = source["ryujinxDir"];
	        this.saveDir = source["saveDir"];
	    }
	}

}

