export class DagError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "DagError";
		this.code = code;
	}
}
