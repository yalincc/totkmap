export namespace main {
	
	export class Config {
	    cemuDir: string;
	    ryujinxDir: string;
	    saveDir: string;
	    emulator: string;
	    game: string;
	
	    static createFrom(source: any = {}) {
	        return new Config(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.cemuDir = source["cemuDir"];
	        this.ryujinxDir = source["ryujinxDir"];
	        this.saveDir = source["saveDir"];
	        this.emulator = source["emulator"];
	        this.game = source["game"];
	    }
	}

}

