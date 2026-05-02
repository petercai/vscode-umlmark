import { Command } from './common';
import { makeDocumentURL } from '../umlmark/urlMaker/urlDocument';

export class CommandURLCurrent extends Command {
    async execute() {
        await makeDocumentURL(false);
    }
    constructor() {
        super("umlmark.URLCurrent");
    }
}