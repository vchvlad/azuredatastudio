/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { normalizeMimeType } from 'vs/base/common/mime';

suite('Mime', () => {

	test('normalize', () => {
		assert.strictEqual(normalizeMimeType('invalid'), 'invalid');
		assert.strictEqual(normalizeMimeType('invalid', true), undefined);
		assert.strictEqual(normalizeMimeType('Text/plain'), 'text/plain');
		assert.strictEqual(normalizeMimeType('Text/pläin'), 'text/pläin');
		assert.strictEqual(normalizeMimeType('Text/plain;UPPER'), 'text/plain;UPPER');
		assert.strictEqual(normalizeMimeType('Text/plain;lower'), 'text/plain;lower');
	});
});
