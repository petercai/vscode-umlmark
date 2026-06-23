import * as vscode from 'vscode';

import { RenderTask, } from '../renders/interfaces';
import { Diagram } from '../diagram/diagram';
import { localize } from '../common';
import { appliedRender } from './appliedRender'
import { ChildProcess } from 'child_process';
import * as path from 'path';
import { config } from '../config';

/**
 * export a diagram to file or to Buffer.
 * @param diagram The diagram to export.
 * @param format format of export file.
 * @param savePath if savePath is given, it exports to a file, or, to Buffer.
 * @param bar display prcessing message in bar if it's given.
 * @returns ExportTask.
 */
export function exportDiagram(diagram: Diagram, format: string, savePath: string, bar: vscode.StatusBarItem): RenderTask {
    if (bar) {
        bar.show();
        bar.text = localize(7, null, diagram.name + "." + format.split(":")[0]);
    }
    let renderTask = appliedRender(diagram.parentUri).render(diagram, format, savePath);
    if (!savePath) {
        // For preview, the image map is built from the SVG's own <a> elements in the previewer.
        // -pipemap outputs coordinates in PNG space which mismatches SVG natural dimensions,
        // causing clicks to land on the wrong link. SVG-derived coords are always aligned.
        return renderTask;
    }

    if (!config.exportMapFile(diagram.parentUri)) return renderTask;

    let bsName = path.basename(savePath);
    let ext = path.extname(savePath);
    let cmapx = path.join(
        path.dirname(savePath),
        bsName.substr(0, bsName.length - ext.length) + ".cmapx",
    );
    let mapTask = appliedRender(diagram.parentUri).getMapData(diagram, cmapx);
    return combine(renderTask, mapTask);
}

function combine(taskA: RenderTask, taskB: RenderTask): RenderTask {
    const processesA = taskA.processes ?? [];
    const processesB = taskB.processes ?? [];
    let processes: ChildProcess[] = [];
    processes.push(...processesA, ...processesB);
    let pms = new Promise<Buffer[]>((resolve, reject) => {
        Promise.all([taskA.promise, taskB.promise]).then(
            results => {
                let buffs: Buffer[] = [];
                buffs = buffs.concat(...results);
                resolve(buffs);
            },
            error => {
                reject(error);
            }
        )
    });
    return <RenderTask>{
        processes: processes,
        promise: pms,
        canceled: false
    }
}