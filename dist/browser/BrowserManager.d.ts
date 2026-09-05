/// <reference types="node" />
/// <reference types="node" />
import { Page } from 'playwright';
export declare class BrowserManager {
    private browser;
    private context;
    private page;
    private headless;
    constructor(headless?: boolean);
    initialize(): Promise<Page>;
    closeModals(): Promise<void>;
    getPage(): Page;
    screenshot(path?: string): Promise<Buffer>;
    close(): Promise<void>;
}
export declare const browserManager: BrowserManager;
