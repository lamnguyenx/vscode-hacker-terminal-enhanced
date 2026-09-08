const ansiRegex = /[\x1B\x9B][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d\/#&.:=?%@~_]*)*)?\x07)|(?:\d{1,4}(?:;\d{0,4})*)?[\dA-ORZcf-nq-uy=><~])/g;

export function stripAnsi(text: string): string {
	return text.replace(ansiRegex, '');
}

export function stripNonPrintable(text: string): string {
	return stripAnsi(text)
		.replace(/\r\n/g, '\n')
		.replace(/\r/g, '\n')
		.replace(/\x00/g, '')
		.replace(/\b/g, '')
		.replace(/\x07/g, '');
}