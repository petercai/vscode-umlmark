import { Command } from './common';
import { exportDocument } from '../umlmark/exporter/exportDocument';

export class CommandExportCurrent extends Command {
    async execute() {
        await exportDocument(false);
    }
    constructor() {
        super("umlmark.exportCurrent");
    }
}