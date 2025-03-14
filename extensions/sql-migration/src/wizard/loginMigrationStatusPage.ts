/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as azdata from 'azdata';
import * as vscode from 'vscode';
import { MigrationWizardPage } from '../models/migrationWizardPage';
import { MigrationStateModel, StateChangeEvent } from '../models/stateMachine';
import * as constants from '../constants/strings';
import { debounce, getPipelineStatusImage } from '../api/utils';
import * as styles from '../constants/styles';
import { IconPathHelper } from '../constants/iconPathHelper';
import { EOL } from 'os';
import { LoginMigrationStatusCodes } from '../constants/helper';

export class LoginMigrationStatusPage extends MigrationWizardPage {
	private _view!: azdata.ModelView;
	private _migratingLoginsTable!: azdata.TableComponent;
	private _loginCount!: azdata.TextComponent;
	private _loginsTableValues!: any[];
	private _disposables: vscode.Disposable[] = [];
	private _progressLoaderContainer!: azdata.FlexContainer;
	private _migrationProgress!: azdata.InfoBoxComponent;
	private _progressLoader!: azdata.LoadingComponent;
	private _progressContainer!: azdata.FlexContainer;
	private _migrationProgressDetails!: azdata.TextComponent;

	constructor(wizard: azdata.window.Wizard, migrationStateModel: MigrationStateModel) {
		super(wizard, azdata.window.createWizardPage(constants.LOGIN_MIGRATIONS_STATUS_PAGE_TITLE), migrationStateModel);
	}

	protected async registerContent(view: azdata.ModelView): Promise<void> {
		this._view = view;

		const flex = view.modelBuilder.flexContainer().withLayout({
			flexFlow: 'row',
			height: '100%',
			width: '100%'
		}).component();
		flex.addItem(await this.createRootContainer(view), { flex: '1 1 auto' });

		this._disposables.push(this._view.onClosed(e => {
			this._disposables.forEach(
				d => { try { d.dispose(); } catch { } });
		}));

		await view.initializeModel(flex);
	}

	public async onPageEnter(): Promise<void> {
		this.wizard.registerNavigationValidator((pageChangeInfo) => {
			if (pageChangeInfo.newPage < pageChangeInfo.lastPage) {
				this.wizard.message = {
					text: constants.LOGIN_MIGRATIONS_STATUS_PAGE_PREVIOUS_BUTTON_ERROR,
					level: azdata.window.MessageLevel.Error
				};
				return false;
			}
			return true;
		});

		this.wizard.backButton.enabled = false;
		this.wizard.backButton.hidden = true;
		this.wizard.backButton.label = constants.LOGIN_MIGRATIONS_STATUS_PAGE_PREVIOUS_BUTTON_TITLE;
		this.wizard.doneButton.enabled = false;

		await this._loadMigratingLoginsList(this.migrationStateModel);

		// load unfiltered table list
		await this._filterTableList('');

		var result = await this._runLoginMigrations();

		if (!result) {
			if (this.migrationStateModel._targetServerInstance) {
				await this._migrationProgress.updateProperties({
					'text': constants.LOGIN_MIGRATIONS_FAILED_STATUS_PAGE_DESCRIPTION(this._getTotalNumberOfLogins(), this.migrationStateModel.GetTargetType(), this.migrationStateModel._targetServerInstance.name),
					'style': 'error',
				});
			} else {
				await this._migrationProgress.updateProperties({
					'text': constants.LOGIN_MIGRATIONS_FAILED,
					'style': 'error',
				});
			}

			this.wizard.message = {
				text: constants.LOGIN_MIGRATIONS_FAILED,
				level: azdata.window.MessageLevel.Error,
				description: constants.LOGIN_MIGRATIONS_ERROR(this.migrationStateModel._loginMigrationsError.message),
			};

			this._progressLoader.loading = false;
		}

		await this._loadMigratingLoginsList(this.migrationStateModel);
		await this._filterTableList('');
	}

	public async onPageLeave(): Promise<void> {
		this.wizard.message = {
			text: '',
			level: azdata.window.MessageLevel.Error
		};

		this.wizard.registerNavigationValidator((pageChangeInfo) => {
			return true;
		});
	}

	protected async handleStateChange(e: StateChangeEvent): Promise<void> {
	}

	private createMigrationProgressLoader(): azdata.FlexContainer {
		this._progressLoader = this._view.modelBuilder.loadingComponent()
			.withProps({
				loadingText: constants.LOGIN_MIGRATION_IN_PROGRESS,
				loadingCompletedText: constants.LOGIN_MIGRATIONS_COMPLETE,
				loading: true,
				CSSStyles: { 'margin-right': '20px' }
			})
			.component();

		this._migrationProgress = this._view.modelBuilder.infoBox()
			.withProps({
				style: 'information',
				text: constants.LOGIN_MIGRATION_IN_PROGRESS,
				CSSStyles: {
					...styles.PAGE_TITLE_CSS,
					'margin-right': '20px',
					'font-size': '13px',
					'line-height': '126%'
				}
			}).component();

		this._progressLoaderContainer = this._view.modelBuilder.flexContainer()
			.withLayout({
				height: '100%',
				flexFlow: 'row',
				alignItems: 'center'
			}).component();

		this._progressLoaderContainer.addItem(this._migrationProgress, { flex: '0 0 auto' });
		this._progressLoaderContainer.addItem(this._progressLoader, { flex: '0 0 auto' });

		return this._progressLoaderContainer;
	}

	private async createMigrationProgressDetails(): Promise<azdata.TextComponent> {
		this._migrationProgressDetails = this._view.modelBuilder.text()
			.withProps({
				value: constants.STARTING_LOGIN_MIGRATION,
				CSSStyles: {
					...styles.BODY_CSS,
					'width': '660px'
				}
			}).component();
		return this._migrationProgressDetails;
	}

	private createSearchComponent(): azdata.DivContainer {
		let resourceSearchBox = this._view.modelBuilder.inputBox().withProps({
			stopEnterPropagation: true,
			placeHolder: constants.SEARCH,
			width: 200
		}).component();

		this._disposables.push(
			resourceSearchBox.onTextChanged(value => this._filterTableList(value)));

		const searchContainer = this._view.modelBuilder.divContainer().withItems([resourceSearchBox]).withProps({
			CSSStyles: {
				'width': '200px',
				'margin-top': '8px'
			}
		}).component();

		return searchContainer;
	}

	@debounce(500)
	private async _filterTableList(value: string): Promise<void> {
		let tableRows = this._loginsTableValues;
		if (this._loginsTableValues && value?.length > 0) {
			tableRows = this._loginsTableValues
				.filter(row => {
					const searchText = value?.toLowerCase();
					return row[0]?.toLowerCase()?.indexOf(searchText) > -1			// source login
						|| row[1]?.toLowerCase()?.indexOf(searchText) > -1			// login type
						|| row[2]?.toLowerCase()?.indexOf(searchText) > -1  		// default database
						|| row[3]?.title.toLowerCase()?.indexOf(searchText) > -1;	// migration status
				});
		}

		await this._migratingLoginsTable.updateProperty('data', tableRows);
		await this.updateDisplayedLoginCount();
	}

	public async createRootContainer(view: azdata.ModelView): Promise<azdata.FlexContainer> {
		await this._loadMigratingLoginsList(this.migrationStateModel);

		this._progressContainer = this._view.modelBuilder.flexContainer()
			.withLayout({ height: '100%', flexFlow: 'column' })
			.withProps({ CSSStyles: { 'margin-bottom': '10px' } })
			.component();

		this._progressContainer.addItem(this.createMigrationProgressLoader(), { flex: '0 0 auto' });
		this._progressContainer.addItem(await this.createMigrationProgressDetails(), { flex: '0 0 auto' });

		this._loginCount = this._view.modelBuilder.text().withProps({
			value: constants.NUMBER_LOGINS_MIGRATING(this._loginsTableValues.length, this._loginsTableValues.length),
			CSSStyles: {
				...styles.BODY_CSS,
				'margin-top': '8px'
			},
			ariaLive: 'polite'
		}).component();

		const cssClass = 'no-borders';
		this._migratingLoginsTable = this._view.modelBuilder.table()
			.withProps({
				data: [],
				width: 650,
				height: '100%',
				forceFitColumns: azdata.ColumnSizingMode.ForceFit,
				columns: [
					{
						name: constants.SOURCE_LOGIN,
						value: 'sourceLogin',
						type: azdata.ColumnType.text,
						width: 250,
						cssClass: cssClass,
						headerCssClass: cssClass,
					},
					{
						name: constants.LOGIN_TYPE,
						value: 'loginType',
						type: azdata.ColumnType.text,
						width: 90,
						cssClass: cssClass,
						headerCssClass: cssClass,
					},
					{
						name: constants.DEFAULT_DATABASE,
						value: 'defaultDatabase',
						type: azdata.ColumnType.text,
						width: 100,
						cssClass: cssClass,
						headerCssClass: cssClass,
					},
					<azdata.HyperlinkColumn>{
						name: constants.LOGIN_MIGRATION_STATUS_COLUMN,
						value: 'migrationStatus',
						width: 120,
						type: azdata.ColumnType.hyperlink,
						icon: IconPathHelper.inProgressMigration,
						showText: true,
						cssClass: cssClass,
						headerCssClass: cssClass,
					},
				]
			}).component();

		this._disposables.push(
			this._migratingLoginsTable.onCellAction!(async (rowState: azdata.ICellActionEventArgs) => {
				const buttonState = <azdata.ICellActionEventArgs>rowState;
				switch (buttonState?.column) {
					case 3:
						const loginName = this._migratingLoginsTable!.data[rowState.row][0];
						const status = this._migratingLoginsTable!.data[rowState.row][3].title;
						const statusMessage = constants.LOGIN_MIGRATION_STATUS_LABEL(status);
						var errors = [];

						if (this.migrationStateModel._loginMigrationsResult?.exceptionMap) {
							const exception_key = Object.keys(this.migrationStateModel._loginMigrationsResult.exceptionMap).find(key => key.toLocaleLowerCase() === loginName.toLocaleLowerCase());
							if (exception_key) {
								for (var exception of this.migrationStateModel._loginMigrationsResult.exceptionMap[exception_key]) {
									if (Array.isArray(exception)) {
										for (var inner_exception of exception) {
											errors.push(inner_exception.Message);
										}
									} else {
										errors.push(exception.Message);
									}
								}
							}
						}

						const unique_errors = new Set(errors);

						// TODO AKMA: Make errors prettier (spacing between errors is weird)
						this.showDialogMessage(
							constants.DATABASE_MIGRATION_STATUS_TITLE,
							statusMessage,
							[...unique_errors].join(EOL));
						break;
				}
			}));

		// load unfiltered table list
		await this._filterTableList('');

		const flex = view.modelBuilder.flexContainer().withLayout({
			flexFlow: 'column',
			height: '100%',
		}).withProps({
			CSSStyles: {
				'margin': '0px 28px 0px 28px'
			}
		}).component();
		flex.addItem(this._progressContainer, { flex: '0 0 auto' });
		flex.addItem(this.createSearchComponent(), { flex: '0 0 auto' });
		flex.addItem(this._loginCount, { flex: '0 0 auto' });
		flex.addItem(this._migratingLoginsTable);
		return flex;
	}

	private async _loadMigratingLoginsList(stateMachine: MigrationStateModel): Promise<void> {
		const loginList = stateMachine._loginsForMigration || [];
		loginList.sort((a, b) => a.loginName.localeCompare(b.loginName));

		this._loginsTableValues = loginList.map(login => {
			const loginName = login.loginName;

			var status = LoginMigrationStatusCodes.InProgress;
			var title = constants.LOGIN_MIGRATION_STATUS_IN_PROGRESS;
			if (stateMachine._loginMigrationsError) {
				status = LoginMigrationStatusCodes.Failed;
				title = constants.LOGIN_MIGRATION_STATUS_FAILED;
			} else if (stateMachine._loginMigrationsResult) {
				status = LoginMigrationStatusCodes.Succeeded;
				title = constants.LOGIN_MIGRATION_STATUS_SUCCEEDED;
				var didLoginFail = Object.keys(stateMachine._loginMigrationsResult.exceptionMap).some(key => key.toLocaleLowerCase() === loginName.toLocaleLowerCase());
				if (didLoginFail) {
					status = LoginMigrationStatusCodes.Failed;
					title = constants.LOGIN_MIGRATION_STATUS_FAILED;
				}
			}

			return [
				loginName,
				login.loginType,
				login.defaultDatabaseName,
				<azdata.HyperlinkColumnCellValue>{
					icon: getPipelineStatusImage(status),
					title: title,
				},
			];
		}) || [];
	}

	private _getTotalNumberOfLogins(): number {
		return this._loginsTableValues?.length || 0;
	}

	private async updateDisplayedLoginCount() {
		await this._loginCount.updateProperties({
			'value': constants.NUMBER_LOGINS_MIGRATING(this._getNumberOfDisplayedLogins(), this._getTotalNumberOfLogins())
		});
	}

	private _getNumberOfDisplayedLogins(): number {
		return this._migratingLoginsTable?.data?.length || 0;
	}

	private async _runLoginMigrations(): Promise<Boolean> {
		this._progressLoader.loading = true;

		if (this.migrationStateModel._targetServerInstance) {
			await this._migrationProgress.updateProperties({
				'text': constants.LOGIN_MIGRATIONS_STATUS_PAGE_DESCRIPTION(this._getTotalNumberOfLogins(), this.migrationStateModel.GetTargetType(), this.migrationStateModel._targetServerInstance.name)
			});
		}

		await this._migrationProgressDetails.updateProperties({
			'value': constants.STARTING_LOGIN_MIGRATION
		});

		var result = await this.migrationStateModel.migrateLogins();

		if (!result) {
			await this._migrationProgressDetails.updateProperties({
				'value': constants.STARTING_LOGIN_MIGRATION_FAILED
			});

			return false;
		}

		await this._migrationProgressDetails.updateProperties({
			'value': constants.ESTABLISHING_USER_MAPPINGS
		});

		result = await this.migrationStateModel.establishUserMappings();

		if (!result) {
			await this._migrationProgressDetails.updateProperties({
				'value': constants.ESTABLISHING_USER_MAPPINGS_FAILED
			});

			return false;
		}

		await this._migrationProgressDetails.updateProperties({
			'value': constants.MIGRATE_SERVER_ROLES_AND_SET_PERMISSIONS
		});

		result = await this.migrationStateModel.migrateServerRolesAndSetPermissions();

		if (!result) {
			await this._migrationProgressDetails.updateProperties({
				'value': constants.MIGRATE_SERVER_ROLES_AND_SET_PERMISSIONS_FAILED
			});

			return false;
		}

		await this._migrationProgressDetails.updateProperties({
			'CSSStyles': { 'display': 'none' },
		});

		if (this.migrationStateModel._targetServerInstance) {
			await this._migrationProgress.updateProperties({
				'text': constants.LOGIN_MIGRATIONS_COMPLETED_STATUS_PAGE_DESCRIPTION(this._getTotalNumberOfLogins(), this.migrationStateModel.GetTargetType(), this.migrationStateModel._targetServerInstance.name),
				'style': 'success',
			});
		} else {
			await this._migrationProgress.updateProperties({
				'text': constants.LOGIN_MIGRATIONS_COMPLETE,
				'style': 'success',
			});
		}

		this._progressLoader.loading = false;

		this.wizard.doneButton.enabled = true;
		return result;
	}
}
