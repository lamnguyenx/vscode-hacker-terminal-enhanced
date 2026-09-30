/**
 * Minimal typing for the VS Code webview host bridge, available as a global
 * inside any webview that enables scripts.
 */
interface VsCodeApi {
	postMessage(message: unknown): void;
	getState(): unknown;
	setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;
