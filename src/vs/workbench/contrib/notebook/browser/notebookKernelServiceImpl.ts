/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event, Emitter } from 'vs/base/common/event';
import { Disposable, IDisposable, toDisposable } from 'vs/base/common/lifecycle';
import { INotebookTextModel } from 'vs/workbench/contrib/notebook/common/notebookCommon';
import { INotebookKernel, ISelectedNotebooksChangeEvent, INotebookKernelMatchResult, INotebookKernelService, INotebookTextModelLike } from 'vs/workbench/contrib/notebook/common/notebookKernelService';
import { LRUCache, ResourceMap } from 'vs/base/common/map';
import { IStorageService, StorageScope, StorageTarget } from 'vs/platform/storage/common/storage';
import { URI } from 'vs/base/common/uri';
import { INotebookService } from 'vs/workbench/contrib/notebook/common/notebookService';
import { runWhenIdle } from 'vs/base/common/async';

class KernelInfo {

	private static _logicClock = 0;

	readonly kernel: INotebookKernel;
	public score: number;
	readonly time: number;

	readonly notebookPriorities = new ResourceMap<number>();

	constructor(kernel: INotebookKernel) {
		this.kernel = kernel;
		this.score = -1;
		this.time = KernelInfo._logicClock++;
	}
}

class NotebookTextModelLikeId {
	static str(k: INotebookTextModelLike): string {
		return `${k.viewType}/${k.uri.toString()}`;
	}
	static obj(s: string): INotebookTextModelLike {
		const idx = s.indexOf('/');
		return {
			viewType: s.substring(0, idx),
			uri: URI.parse(s.substring(idx + 1))
		};
	}
}

export class NotebookKernelService extends Disposable implements INotebookKernelService {

	declare _serviceBrand: undefined;

	private readonly _kernels = new Map<string, KernelInfo>();

	private readonly _typeBindings = new LRUCache<string, string>(100, 0.7);
	private readonly _notebookBindings = new LRUCache<string, string>(1000, 0.7);

	private readonly _onDidChangeNotebookKernelBinding = this._register(new Emitter<ISelectedNotebooksChangeEvent>());
	private readonly _onDidAddKernel = this._register(new Emitter<INotebookKernel>());
	private readonly _onDidRemoveKernel = this._register(new Emitter<INotebookKernel>());
	private readonly _onDidChangeNotebookAffinity = this._register(new Emitter<void>());

	readonly onDidChangeSelectedNotebooks: Event<ISelectedNotebooksChangeEvent> = this._onDidChangeNotebookKernelBinding.event;
	readonly onDidAddKernel: Event<INotebookKernel> = this._onDidAddKernel.event;
	readonly onDidRemoveKernel: Event<INotebookKernel> = this._onDidRemoveKernel.event;
	readonly onDidChangeNotebookAffinity: Event<void> = this._onDidChangeNotebookAffinity.event;

	private static _storageNotebookBinding = 'notebook.controller2NotebookBindings';
	private static _storageTypeBinding = 'notebook.controller2TypeBindings';

	constructor(
		@INotebookService private readonly _notebookService: INotebookService,
		@IStorageService private readonly _storageService: IStorageService,
	) {
		super();

		// auto associate kernels to new notebook documents, also emit event when
		// a notebook has been closed (but don't update the memento)
		this._register(_notebookService.onDidAddNotebookDocument(this._tryAutoBindNotebook, this));
		this._register(_notebookService.onWillRemoveNotebookDocument(notebook => {
			const kernelId = this._notebookBindings.get(NotebookTextModelLikeId.str(notebook));
			if (kernelId) {
				this._onDidChangeNotebookKernelBinding.fire({ notebook: notebook.uri, oldKernel: kernelId, newKernel: undefined });
			}
		}));

		// restore from storage
		try {
			const data = JSON.parse(this._storageService.get(NotebookKernelService._storageNotebookBinding, StorageScope.WORKSPACE, '[]'));
			this._notebookBindings.fromJSON(data);
		} catch {
			// ignore
		}
		try {
			const data = JSON.parse(this._storageService.get(NotebookKernelService._storageTypeBinding, StorageScope.GLOBAL, '[]'));
			this._typeBindings.fromJSON(data);
		} catch {
			// ignore
		}
	}

	override dispose() {
		this._kernels.clear();
		super.dispose();
	}

	private _persistSoonHandle?: IDisposable;

	private _persistMementos(): void {
		this._persistSoonHandle?.dispose();
		this._persistSoonHandle = runWhenIdle(() => {
			this._storageService.store(NotebookKernelService._storageNotebookBinding, JSON.stringify(this._notebookBindings), StorageScope.WORKSPACE, StorageTarget.MACHINE);
			this._storageService.store(NotebookKernelService._storageTypeBinding, JSON.stringify(this._typeBindings), StorageScope.GLOBAL, StorageTarget.USER);
		}, 100);
	}

	private static _score(kernel: INotebookKernel, notebook: INotebookTextModelLike): number {
		if (kernel.viewType === '*') {
			return 5;
		} else if (kernel.viewType === notebook.viewType) {
			return 10;
		} else {
			return 0;
		}
	}

	private _tryAutoBindNotebook(notebook: INotebookTextModel, onlyThisKernel?: INotebookKernel): void {

		const id = this._notebookBindings.get(NotebookTextModelLikeId.str(notebook));
		if (!id) {
			// no kernel associated
			return;
		}
		const existingKernel = this._kernels.get(id);
		if (!existingKernel || !NotebookKernelService._score(existingKernel.kernel, notebook)) {
			// associated kernel not known, not matching
			return;
		}
		if (!onlyThisKernel || existingKernel.kernel === onlyThisKernel) {
			this._onDidChangeNotebookKernelBinding.fire({ notebook: notebook.uri, oldKernel: undefined, newKernel: existingKernel.kernel.id });
		}
	}

	registerKernel(kernel: INotebookKernel): IDisposable {
		if (this._kernels.has(kernel.id)) {
			throw new Error(`NOTEBOOK CONTROLLER with id '${kernel.id}' already exists`);
		}

		this._kernels.set(kernel.id, new KernelInfo(kernel));
		this._onDidAddKernel.fire(kernel);

		// auto associate the new kernel to existing notebooks it was
		// associated to in the past.
		for (const notebook of this._notebookService.getNotebookTextModels()) {
			this._tryAutoBindNotebook(notebook, kernel);
		}

		return toDisposable(() => {
			if (this._kernels.delete(kernel.id)) {
				this._onDidRemoveKernel.fire(kernel);
			}
			for (const [key, candidate] of Array.from(this._notebookBindings)) {
				if (candidate === kernel.id) {
					this._onDidChangeNotebookKernelBinding.fire({ notebook: NotebookTextModelLikeId.obj(key).uri, oldKernel: kernel.id, newKernel: undefined });
				}
			}
		});
	}

	getMatchingKernel(notebook: INotebookTextModelLike): INotebookKernelMatchResult {

		// all applicable kernels
		const kernels: { kernel: INotebookKernel; instanceAffinity: number; typeAffinity: number; score: number }[] = [];
		for (const info of this._kernels.values()) {
			const score = NotebookKernelService._score(info.kernel, notebook);
			if (score) {
				kernels.push({
					score,
					kernel: info.kernel,
					instanceAffinity: info.notebookPriorities.get(notebook.uri) ?? 1 /* vscode.NotebookControllerPriority.Default */,
					typeAffinity: this._typeBindings.get(info.kernel.viewType) === info.kernel.id ? 1 : 0
				});
			}
		}

		kernels
			.sort((a, b) => b.instanceAffinity - a.instanceAffinity || b.typeAffinity - a.typeAffinity || a.score - b.score || a.kernel.label.localeCompare(b.kernel.label));
		const all = kernels.map(obj => obj.kernel);

		// bound kernel
		const selectedId = this._notebookBindings.get(NotebookTextModelLikeId.str(notebook));
		const selected = selectedId ? this._kernels.get(selectedId)?.kernel : undefined;
		const suggestions = kernels.filter(item => item.instanceAffinity > 1 && item.kernel !== selected).map(item => item.kernel);
		if (!suggestions.length && all.length) {
			suggestions.push(all[0]);
		}
		return { all, selected, suggestions };
	}

	getSelectedOrSuggestedKernel(notebook: INotebookTextModel): INotebookKernel | undefined {
		const info = this.getMatchingKernel(notebook);
		if (info.selected) {
			return info.selected;
		}

		const preferred = info.all.filter(kernel => this._kernels.get(kernel.id)?.notebookPriorities.get(notebook.uri) === 2 /* vscode.NotebookControllerPriority.Preferred */);
		if (preferred.length === 1) {
			return preferred[0];
		}

		return info.all.length === 1 ? info.all[0] : undefined;
	}

	// default kernel for notebookType
	selectKernelForNotebookType(kernel: INotebookKernel, typeId: string): void {
		const existing = this._typeBindings.get(typeId);
		if (existing !== kernel.id) {
			this._typeBindings.set(typeId, kernel.id);
			this._persistMementos();
			this._onDidChangeNotebookAffinity.fire();
		}
	}

	// a notebook has one kernel, a kernel has N notebooks
	// notebook <-1----N-> kernel
	selectKernelForNotebook(kernel: INotebookKernel, notebook: INotebookTextModelLike): void {
		const key = NotebookTextModelLikeId.str(notebook);
		const oldKernel = this._notebookBindings.get(key);
		if (oldKernel !== kernel?.id) {
			if (kernel) {
				this._notebookBindings.set(key, kernel.id);
			} else {
				this._notebookBindings.delete(key);
			}
			this._onDidChangeNotebookKernelBinding.fire({ notebook: notebook.uri, oldKernel, newKernel: kernel.id });
			this._persistMementos();
		}
	}

	preselectKernelForNotebook(kernel: INotebookKernel, notebook: INotebookTextModelLike): void {
		const key = NotebookTextModelLikeId.str(notebook);
		const oldKernel = this._notebookBindings.get(key);
		if (oldKernel !== kernel?.id) {
			this._notebookBindings.set(key, kernel.id);
			this._persistMementos();
		}
	}

	updateKernelNotebookAffinity(kernel: INotebookKernel, notebook: URI, preference: number | undefined): void {
		const info = this._kernels.get(kernel.id);
		if (!info) {
			throw new Error(`UNKNOWN kernel '${kernel.id}'`);
		}
		if (preference === undefined) {
			info.notebookPriorities.delete(notebook);
		} else {
			info.notebookPriorities.set(notebook, preference);
		}
		this._onDidChangeNotebookAffinity.fire();
	}
}
