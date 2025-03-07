/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from 'vs/base/common/event';
import { Disposable } from 'vs/base/common/lifecycle';
import { isWeb } from 'vs/base/common/platform';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { IStorageService, IStorageValueChangeEvent, StorageScope, StorageTarget } from 'vs/platform/storage/common/storage';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { ALL_SYNC_RESOURCES, getEnablementKey, IUserDataSyncEnablementService, IUserDataSyncStoreManagementService, SyncResource } from 'vs/platform/userDataSync/common/userDataSync';

type SyncEnablementClassification = {
	enabled?: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; isMeasurement: true };
};

const enablementKey = 'sync.enable';

export class UserDataSyncEnablementService extends Disposable implements IUserDataSyncEnablementService {

	_serviceBrand: any;

	private _onDidChangeEnablement = new Emitter<boolean>();
	readonly onDidChangeEnablement: Event<boolean> = this._onDidChangeEnablement.event;

	private _onDidChangeResourceEnablement = new Emitter<[SyncResource, boolean]>();
	readonly onDidChangeResourceEnablement: Event<[SyncResource, boolean]> = this._onDidChangeResourceEnablement.event;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IEnvironmentService protected readonly environmentService: IEnvironmentService,
		@IUserDataSyncStoreManagementService private readonly userDataSyncStoreManagementService: IUserDataSyncStoreManagementService,
	) {
		super();
		this._register(storageService.onDidChangeValue(e => this.onDidStorageChange(e)));
	}

	isEnabled(): boolean {
		switch (this.environmentService.sync) {
			case 'on':
				return true;
			case 'off':
				return false;
		}
		// return this.storageService.getBoolean(enablementKey, StorageScope.GLOBAL, false); // {{SQL CARBON EDIT}} - unreachable code
	}

	canToggleEnablement(): boolean {
		return this.userDataSyncStoreManagementService.userDataSyncStore !== undefined && this.environmentService.sync === undefined;
	}

	setEnablement(enabled: boolean): void {
		if (enabled && !this.canToggleEnablement()) {
			return;
		}
		this.telemetryService.publicLog2<{ enabled: boolean }, SyncEnablementClassification>(enablementKey, { enabled });
		this.storageService.store(enablementKey, enabled, StorageScope.GLOBAL, StorageTarget.MACHINE);
	}

	isResourceEnabled(resource: SyncResource): boolean {
		return this.storageService.getBoolean(getEnablementKey(resource), StorageScope.GLOBAL, true);
	}

	setResourceEnablement(resource: SyncResource, enabled: boolean): void {
		if (this.isResourceEnabled(resource) !== enabled) {
			const resourceEnablementKey = getEnablementKey(resource);
			this.storeResourceEnablement(resourceEnablementKey, enabled);
		}
	}

	getResourceSyncStateVersion(resource: SyncResource): string | undefined {
		return undefined;
	}

	private storeResourceEnablement(resourceEnablementKey: string, enabled: boolean): void {
		this.storageService.store(resourceEnablementKey, enabled, StorageScope.GLOBAL, isWeb ? StorageTarget.USER /* sync in web */ : StorageTarget.MACHINE);
	}

	private onDidStorageChange(storageChangeEvent: IStorageValueChangeEvent): void {
		if (storageChangeEvent.scope !== StorageScope.GLOBAL) {
			return;
		}

		if (enablementKey === storageChangeEvent.key) {
			this._onDidChangeEnablement.fire(this.isEnabled());
			return;
		}

		const resourceKey = ALL_SYNC_RESOURCES.filter(resourceKey => getEnablementKey(resourceKey) === storageChangeEvent.key)[0];
		if (resourceKey) {
			this._onDidChangeResourceEnablement.fire([resourceKey, this.isResourceEnabled(resourceKey)]);
			return;
		}
	}
}
