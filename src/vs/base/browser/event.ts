/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { GestureEvent } from 'vs/base/browser/touch';
import { Emitter, Event as BaseEvent } from 'vs/base/common/event';
import { IDisposable } from 'vs/base/common/lifecycle';

export type EventHandler = HTMLElement | HTMLDocument | Window;

export interface IDomEvent {
	<K extends keyof HTMLElementEventMap>(element: EventHandler, type: K, useCapture?: boolean): BaseEvent<HTMLElementEventMap[K]>;
	(element: EventHandler, type: string, useCapture?: boolean): BaseEvent<unknown>;
}

export interface DOMEventMap extends HTMLElementEventMap, DocumentEventMap, WindowEventMap {
	'-monaco-gesturetap': GestureEvent;
	'-monaco-gesturechange': GestureEvent;
	'-monaco-gesturestart': GestureEvent;
	'-monaco-gesturesend': GestureEvent;
	'-monaco-gesturecontextmenu': GestureEvent;
}

export class DomEmitter<K extends keyof DOMEventMap> implements IDisposable {

	private emitter: Emitter<DOMEventMap[K]>;

	get event(): BaseEvent<DOMEventMap[K]> {
		return this.emitter.event;
	}

	constructor(element: Window & typeof globalThis, type: WindowEventMap, useCapture?: boolean);
	constructor(element: Document, type: DocumentEventMap, useCapture?: boolean);
	constructor(element: EventHandler, type: K, useCapture?: boolean);
	constructor(element: EventHandler, type: K, useCapture?: boolean) {
		const fn = (e: Event) => this.emitter.fire(e as DOMEventMap[K]);
		this.emitter = new Emitter({
			onFirstListenerAdd: () => element.addEventListener(type, fn, useCapture),
			onLastListenerRemove: () => element.removeEventListener(type, fn, useCapture)
		});
	}

	dispose(): void {
		this.emitter.dispose();
	}
}

export interface CancellableEvent {
	preventDefault(): void;
	stopPropagation(): void;
}

export function stopEvent<T extends CancellableEvent>(event: T): T {
	event.preventDefault();
	event.stopPropagation();
	return event;
}

export function stop<T extends CancellableEvent>(event: BaseEvent<T>): BaseEvent<T> {
	return BaseEvent.map(event, stopEvent);
}
