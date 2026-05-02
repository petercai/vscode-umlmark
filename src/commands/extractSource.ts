import { Command } from './common';
import { extractSource } from '../umlmark/sourceExtracter/extractSource';

export class CommandExtractSource extends Command {
    async execute() {
        await extractSource();
    }
    constructor() {
        super("umlmark.extractSource");
    }
}