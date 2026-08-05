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
const DEFAULT_FOOTER = Object.freeze({
    text: 'WN Helper by Michael Lindberg. Discord: milkgames',
    iconURL: 'https://i.imgur.com/zdxWb0s.jpeg',
});

function getDefaultFooter() {
    return { ...DEFAULT_FOOTER };
}

module.exports = {
    DEFAULT_FOOTER,
    getDefaultFooter,
};
