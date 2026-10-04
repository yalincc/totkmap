export namespace main {
	
	export class Config {
	    edenDir: string;
	    saveDir: string;
	
	    static createFrom(source: any = {}) {
	        return new Config(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.edenDir = source["edenDir"];
	        this.saveDir = source["saveDir"];
	    }
	}

}

