/*
 * WN Helper Discord Bot
 * Copyright (C) 2026 MilkGames
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */
const batchPresentation = require('./batchPresentation');
const batchService = require('./batchService');
const StaffAuditError = require('./error');
const events = require('./events');
const massAuditParser = require('./massAuditParser');
const operations = require('./operations');
const policy = require('./policy');
const promotionPolicy = require('./promotionPolicy');
const presentation = require('./presentation');
const ranks = require('./ranks');
const service = require('./service');
const schema = require('./settings/schema');
const ranksSchema = require('../../core/config/rankSchema');
const invite = require('./commands/invite');
const massAudit = require('./commands/massAudit');
const rank = require('./commands/rank');
const uval = require('./commands/uval');

module.exports = {
    name: 'staff-audit',
    commands: [invite, massAudit, rank, uval],
    events,
    actions: {
        'staff-audit.dismissMember': service.dismissMember,
        'staff-audit.extractStaticId': service.extractStaticId,
        'staff-audit.sendDismissalRecord': service.sendDismissalRecord,
        'staff-audit.executeOperation': operations.executeOperation,
        'staff-audit.getOperation': operations.getOperation,
    },
    StaffAuditError,
    ...batchPresentation,
    ...batchService,
    ...massAuditParser,
    ...operations,
    ...policy,
    ...promotionPolicy,
    ...presentation,
    ...ranks,
    ...service,
    ...schema,
    ...ranksSchema,
};
