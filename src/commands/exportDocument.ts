import { Command } from './common';
import { exportDocument } from '../umlmark/exporter/exportDocument';

export class CommandExportDocument extends Command {
    async execute() {
        await exportDocument(true);
    }
    constructor() {
        super("umlmark.exportDocument");
    }
}