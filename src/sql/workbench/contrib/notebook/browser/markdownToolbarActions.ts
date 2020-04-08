/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Action } from 'vs/base/common/actions';

import { INotebookEditor, INotebookService } from 'sql/workbench/services/notebook/browser/notebookService';
import { CodeEditorWidget } from 'vs/editor/browser/widget/codeEditorWidget';
import { IRange } from 'vs/editor/common/core/range';
import { IIdentifiedSingleEditOperation } from 'vs/editor/common/model';
import { TextModel } from 'vs/editor/common/model/textModel';
import { ICellModel } from 'sql/workbench/services/notebook/browser/models/modelInterfaces';
import { QueryTextEditor } from 'sql/workbench/browser/modelComponents/queryTextEditor';



// Action to decorate markdown
export class TransformMarkdownAction extends Action {

	constructor(
		id: string,
		label: string,
		cssClass: string,
		tooltip: string,
		private _cellModel: ICellModel,
		private _type: MarkdownButtonType,
		@INotebookService private _notebookService: INotebookService
	) {
		super(id, label, cssClass);
		this._tooltip = tooltip;
	}
	public run(context: any): Promise<boolean> {
		return new Promise<boolean>((resolve, reject) => {
			try {
				let markdownTextTransformer = new MarkdownTextTransformer(this._notebookService, this._cellModel);
				markdownTextTransformer.transformText(this._type);
				resolve(true);
			} catch (e) {
				reject(e);
			}
		});
	}
}

export class MarkdownTextTransformer {

	private _notebookEditor: INotebookEditor;
	constructor(private _notebookService: INotebookService, private _cellModel: ICellModel) { }

	public transformText(type: MarkdownButtonType): void {
		let editorControl = this.getEditorControl();
		if (editorControl) {
			let selections = editorControl.getSelections();
			// TODO: Support replacement for multiple selections
			let selection = selections[0];
			let startRange: IRange = {
				startColumn: selection.startColumn,
				endColumn: selection.startColumn,
				startLineNumber: selection.startLineNumber,
				endLineNumber: selection.startLineNumber
			};

			// Get text to insert before selection
			let beginInsertedCode = this.getStartTextToInsert(type);
			// Get text to insert after selection
			let endInsertedCode = this.getEndTextToInsert(type);

			// endInsertedCode can be an empty string (e.g. for unordered list), so no need to check for that as well
			if (beginInsertedCode) {
				// If selection end is on same line as beginning, need to add offset for number of characters inserted
				// Otherwise, if you're bolding "Sample Phrase", without the offset, the text model will have
				// "**Sample Phra**se"
				let offset = selection.startLineNumber === selection.endLineNumber ? beginInsertedCode.length : 0;
				let endRange: IRange = {
					startColumn: selection.endColumn + offset,
					endColumn: selection.endColumn + offset,
					startLineNumber: selection.endLineNumber,
					endLineNumber: selection.endLineNumber
				};
				let editorModel = editorControl.getModel() as TextModel;
				if (editorModel) {
					let markdownLineType = this.getMarkdownLineType(type);
					// If the markdown we're inserting only needs to be added to the begin and end lines, add those edit operations directly
					if (markdownLineType === MarkdownLineType.BEGIN_AND_END_LINES) {
						editorModel.pushEditOperations(selections, [{ range: startRange, text: beginInsertedCode }, { range: endRange, text: endInsertedCode }], null);
					} else { // Otherwise, add an operation per line (plus the operation at the last column + line)
						let operations: IIdentifiedSingleEditOperation[] = [];
						for (let i = 0; i < selection.endLineNumber - selection.startLineNumber + 1; i++) {
							operations.push({ range: this.transformRangeByLineOffset(startRange, i), text: beginInsertedCode });
						}
						operations.push({ range: endRange, text: endInsertedCode });
						editorModel.pushEditOperations(selections, operations, null);
					}
				}
				this.setEndSelection(endRange, type, editorControl);
			}
		}
	}

	// For items like lists (where we need to insert a character at the beginning of each line), create
	// range object for that range
	private transformRangeByLineOffset(range: IRange, lineOffset: number): IRange {
		return {
			startColumn: lineOffset === 0 ? range.startColumn : 1,
			endColumn: range.endColumn,
			startLineNumber: range.endLineNumber + lineOffset,
			endLineNumber: range.endLineNumber + lineOffset
		};
	}

	private getStartTextToInsert(type: MarkdownButtonType): string {
		switch (type) {
			case MarkdownButtonType.BOLD:
				return '**';
			case MarkdownButtonType.ITALIC:
				return '_';
			case MarkdownButtonType.CODE:
				return '```\n';
			case MarkdownButtonType.LINK:
				return '[';
			case MarkdownButtonType.UNORDERED_LIST:
				return '- ';
			case MarkdownButtonType.ORDERED_LIST:
				return '1. ';
			case MarkdownButtonType.IMAGE:
				return '![ALT TEXT](';
			case MarkdownButtonType.HIGHLIGHT:
				return '<mark>';
			default:
				return '';
		}
	}

	private getEndTextToInsert(type: MarkdownButtonType): string {
		switch (type) {
			case MarkdownButtonType.BOLD:
				return '**';
			case MarkdownButtonType.ITALIC:
				return '_';
			case MarkdownButtonType.CODE:
				return '\n```';
			case MarkdownButtonType.LINK:
				return ']()';
			case MarkdownButtonType.IMAGE:
				return ')';
			case MarkdownButtonType.HIGHLIGHT:
				return '</mark>';
			case MarkdownButtonType.UNORDERED_LIST:
			case MarkdownButtonType.ORDERED_LIST:
			default:
				return '';
		}
	}

	private getMarkdownLineType(type: MarkdownButtonType): MarkdownLineType {
		switch (type) {
			case MarkdownButtonType.UNORDERED_LIST:
			case MarkdownButtonType.ORDERED_LIST:
				return MarkdownLineType.EVERY_LINE;
			default:
				return MarkdownLineType.BEGIN_AND_END_LINES;
		}
	}

	// Get offset from the end column for editor selection
	// For example, when inserting a link, we want to have the cursor be present in between the brackets
	private getColumnOffsetForSelection(type: MarkdownButtonType): number {
		switch (type) {
			case MarkdownButtonType.LINK:
				return 2;
			case MarkdownButtonType.IMAGE:
				return 0;
			// -1 is considered as having no explicit offset, so do not do anything with selection
			default: return -1;
		}
	}

	private getEditorControl(): CodeEditorWidget {
		if (!this._notebookEditor) {
			this._notebookEditor = this._notebookService.findNotebookEditor(this._cellModel.notebookModel.notebookUri);
		}
		if (this._notebookEditor && this._notebookEditor.cellEditors && this._notebookEditor.cellEditors.length > 0) {
			// Find cell editor provider via cell guid
			let cellEditorProvider = this._notebookEditor.cellEditors.find(e => e.cellGuid() === this._cellModel.cellGuid);
			if (cellEditorProvider) {
				let editor = cellEditorProvider.getEditor() as QueryTextEditor;
				if (editor) {
					let editorControl = editor.getControl() as CodeEditorWidget;
					return editorControl;
				}
			}
		}
		return undefined;
	}

	// Set selection (which also controls the cursor) for a given button type
	private setEndSelection(range: IRange, type: MarkdownButtonType, editorControl: CodeEditorWidget) {
		if (!range || !type || !editorControl) {
			return;
		}
		let offset = this.getColumnOffsetForSelection(type);
		if (offset > -1) {
			let newRange: IRange = {
				startColumn: range.startColumn + offset,
				endColumn: range.endColumn + offset,
				startLineNumber: range.startLineNumber,
				endLineNumber: range.endLineNumber
			};
			editorControl.setSelection(newRange);
		}
		// Always give focus back to the editor after pressing the button
		editorControl.focus();
	}
}

export enum MarkdownButtonType {
	BOLD,
	ITALIC,
	CODE,
	HIGHLIGHT,
	LINK,
	UNORDERED_LIST,
	ORDERED_LIST,
	IMAGE
}

// If ALL_LINES, we need to insert markdown at each line (e.g. lists)
export enum MarkdownLineType {
	BEGIN_AND_END_LINES,
	EVERY_LINE
}
