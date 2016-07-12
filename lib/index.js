'use strict';

const assert = require('assert');
const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const jsonpatch = require('fast-json-patch');
const _ = require('lodash');

const RollbackError = function (message, extra) {
    Error.captureStackTrace(this, this.constructor);
    this.name = this.constructor.name;
    this.message = message;
    this.extra = extra;
}
require('util').inherits(RollbackError, Error);

const patchHistory = function(schema, opts) {

    const defaultOptions = {
        includes: {},
        removePatches: true
    };

    const options = _.merge({}, defaultOptions, opts);

    const createPatchSchema = (options) => {
        const def = {
            date: {type: Date, required: true, default: Date.now},
            ops: {type: [], required: true},
            ref: {type: Schema.Types.ObjectId, required: true, index: true}
        };

        _.each(options.includes, (type, name) => {
            def[name] = _.omit(type, 'from')
        });

        return new Schema(def)
    }

    // validate parameters

    assert(!schema.methods.data, 'conflicting instance method: `data`')

    // used to compare instance data snapshots. depopulates instance,
    // removes version key and object id
    schema.methods.data = function () {
        return this.toObject({
            depopulate: true,
            versionKey: false,
            transform: (doc, ret, options) => {
                delete ret._id;
                // if timestamps option is set on schema, ignore timestamp fields
                if (schema.options.timestamps) {
                    delete ret[schema.options.timestamps.createdAt || 'createdAt'];
                    delete ret[schema.options.timestamps.updatedAt || 'updatedAt'];
                }
            }
        })
    };

    // roll the document back to the state of a given patch id
    schema.methods.rollback = function (patchId, data) {
        return this.patches.count({ref: this.id, _id: {$gte: patchId}})
            .then(count => {
                if (count === 1) {
                    throw new RollbackError('rollback to latest patch');
                }
            })
            .then(() => this.patches.find({ref: this.id, _id: {$lte: patchId}}).sort({date: 1}))
            .then(patches => {
                if (!patches || !patches.find(patch => patch.id == patchId)) {
                    throw new RollbackError('patch doesn\'t exist')
                }
                // apply patches to `state`
                const state = {};
                patches.forEach(patch => jsonpatch.apply(state, patch.ops, true));

                // save new state and resolve with the resulting document
                return this.set(_.merge(data, state)).save()
            })
    };

    /**
     * Return patches Model, register patches Schema if it not registered yet
     * @returns mongoose.Model
     */
    const getPatchModel = function () {
        let model = typeof this === 'function' ? this : this.constructor;
        let modelName = options.modelName || model.modelName + 'Patches';

        if (model.db.modelNames().indexOf(modelName) === -1) {
            model.db.model(modelName, createPatchSchema(options))
        }
        return model.db.model(modelName)
    };

    // create patch model, enable static model access via `patches()` and
    // instance method access through an instances `patches` property
    schema.statics.patches = getPatchModel;
    schema.virtual('patches').get(getPatchModel);

    // after a document is initialized or saved, fresh snapshots of the
    // documents data are created
    const snapshot = function () {
        this._original = this.data()
    };

    schema.post('init', snapshot);
    schema.post('save', snapshot);

    // when a document is removed and `removePatches` is not set to false ,
    // all patch documents from the associated patch collection are also removed
    schema.pre('remove', function (next) {
        if (!options.removePatches) {
            return next()
        }
        this.patches.find({ref: this.id})
            .then(patches => Promise.all(patches.map(patch => patch.remove())))
            .then(next).catch(next)
    });

    // when a document is saved, the json patch that reflects the changes is
    // computed. if the patch consists of one or more operations (meaning the
    // document has changed), a new patch document reflecting the changes is
    // added to the associated patch collection
    schema.pre('save', function (next) {
        const {_id: ref} = this;
        const ops = jsonpatch.compare(this.isNew ? {} : this._original, this.data());

        // don't save a patch when there are no changes to save
        if (!ops.length) {
            return next()
        }

        // assemble patch data
        const data = {ops, ref};
        _.each(options.includes, (type, name) => {
            data[name] = this[type.from || name]
        });

        this.patches.create(data).then(next).catch(next)
    })
}

module.exports = patchHistory;
module.exports.RollbackError = RollbackError;