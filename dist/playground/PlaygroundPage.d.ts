/// <reference types="node" />
/// <reference types="node" />
import { Page } from 'playwright';
export declare class PlaygroundPage {
    private page;
    private lastSentMessage;
    constructor(page?: Page);
    private findFirst;
    private removeOverlays;
    sendMessage(message: string): Promise<void>;
    waitForResponse(timeout?: number): Promise<string>;
    private extractModelResponse;
    getLastResponse(): Promise<string>;
    takeScreenshot(path?: string): Promise<Buffer>;
}
export declare let playgroundPage: PlaygroundPage;
export declare function initPlaygroundPage(page?: Page): PlaygroundPage;
