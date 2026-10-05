const ansiRegex = /[\x1B\x9B][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d\/#&.:=?%@~_ ]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d\/#&.:=?%@~_ ]*)*)?\x07)|(?:\d{1,4}(?:;\d{0,4})*)?[\dA-ORZcf-nq-uy=><~])/g;

/**
 * OSC sequences (starting `ESC ]`, terminated by BEL or ST). VS Code's shell
 * integration emits `OSC 633 ; ...` markers whose payload can contain almost
 * any printable byte (including `$`, quotes and `\x3b` escapes), so they must
 * be cut at the terminator rather than matched by character class.
 */
const oscRegex = /\x1B\][^\x07]*(?:\x07|\x1B\\)/g;

export function stripAnsi(text: string): string {
	return text.replace(oscRegex, '').replace(ansiRegex, '');
}

export function stripNonPrintable(text: string): string {
	return stripAnsi(text)
		.replace(/\r\n/g, '\n')
		.replace(/\r/g, '\n')
		.replace(/\x00/g, '')
		.replace(/\b/g, '')
		.replace(/\x07/g, '');
}