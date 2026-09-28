import {can} from '../access/catalog.js';
export const workCapabilities = user => ({
 view:can(user,'work.view'),execute:can(user,'work.execute'),pick:can(user,'work.pick'),put:can(user,'work.put'),
 teamView:can(user,'work.team'),assign:can(user,'work.assign'),review:can(user,'review.view'),resolve:can(user,'review.resolve'),
 link:can(user,'review.link'),resolveStop:can(user,'review.stop'),reconcile:can(user,'review.reconcile'),
 timing:can(user,'work.timing'),deadline:can(user,'work.deadline'),stop:can(user,'work.stop'),teamStop:can(user,'work.teamStop'),
 correct:can(user,'work.correct'),report:can(user,'work.report'),mode:can(user,'locations.mode'),labels:can(user,'locations.labels'),
 countView:can(user,'count.view'),locationsView:can(user,'locations.view'),
});
