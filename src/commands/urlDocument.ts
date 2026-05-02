import { Command } from './common';
import { makeDocumentURL } from '../umlmark/urlMaker/urlDocument';

export class CommandURLDocument extends Command {
    async execute() {
        await makeDocumentURL(true);
    }
    constructor() {
        super("umlmark.URLDocument");
    }
}