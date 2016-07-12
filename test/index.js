'use strict';

const assert = require('assert');
const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const patchHistory = require('../lib');
const RollbackError = patchHistory.RollbackError;

const ObjectId = mongoose.Types.ObjectId;
const CommentSchema = new Schema({text: String});

mongoose.Promise = Promise;

CommentSchema.virtual('user').set(function (user) {
    this._user = user
});

CommentSchema.plugin(patchHistory, {
    removePatches: false,
    includes: {
        text: {
            type: String
        },
        user: {
            type: Schema.Types.ObjectId,
            required: true,
            from: '_user'
        }
    }
});

const PostSchema = new Schema({title: String}, {timestamps: true});
const UserSchema = new Schema({name: String}, {timestamps: true});

PostSchema.plugin(patchHistory, {});

describe('mongoose-patch-history', () => {

    let db, db2, Comment, Post, User, Comment2, Post2, User2;

    before(done => {

        const dbName = 'mongoose-patch-history-plugin-test-' + ObjectId();
        const db2Name = `${dbName}-2`;

        db = mongoose.createConnection('localhost', dbName);
        db2 = mongoose.createConnection('localhost', db2Name);

        db.on('connected', () => {
            Comment = db.model('Comment', CommentSchema);
            Post = db.model('Post', PostSchema);
            User = db.model('User', UserSchema);
            Comment2 = db2.model('Comment', CommentSchema);
            Post2 = db2.model('Post', PostSchema);
            User2 = db2.model('User', UserSchema);

            Promise.all([
                    Comment.remove(),
                    Comment.patches().remove(),
                    Post.remove(),
                    User.remove(),
                    Comment2.remove(),
                    Comment2.patches().remove(),
                    Post2.remove(),
                    User2.remove()
                ])
                .then(() => User.create({name: 'user'}))
                .then(() => User2.create({name: 'user2'}))
                .then(() => done())
                .catch(done)
        })

    });

    after(function() {
        db.db.dropDatabase();
        db2.db.dropDatabase();
    });

    describe('initialization', () => {
        const name = 'testPatches';
        let TestSchema;

        before(() => {
            TestSchema = new Schema()
        });

        it('throws when `data` instance method exists', () => {
            const DataSchema = new Schema();
            DataSchema.methods.data = () => {
            };
            assert.throws(() => DataSchema.plugin(patchHistory, {mongoose, name}))
        });

        it('does not throw with valid parameters', () => {
            assert.doesNotThrow(() => TestSchema.plugin(patchHistory, {
                mongoose,
                name
            }))
        });
        it('should create patches collection', done => {
            Comment.patches();
            db.db.listCollections({name: 'commentpatches'}).next((err, collinfo) => done(!collinfo));
        });
        it('should create patches collection in second db', () => {
            Comment2.patches();
            db2.db.listCollections({name: 'commentpatches'}).next((err, collinfo) => done(err));
        })
    });

    describe('new document saved', () => {
        let post, patches;
        before(done => {
            Post.create({title: 'foo'})
                .then(doc => post = doc)
                .then(post => post.patches.find({ref: post.id}))
                .then(docs => patches = docs)
                .then(() => done())
                .catch(done);
        });
        it('should create patch document', () => assert.equal(patches.length, 1));
        it('should have patch with correct data', () => assert.deepEqual(patches[0].ops.toObject(), [{
                value: 'foo',
                path: '/title',
                op: 'add'
            }]
        ))
    });
    describe('new document saved (with referenced user)', () => {
        let comment, user, patches;
        before(done => {
            User.findOne()
                .then(doc => user = doc)
                .then(() => Comment.create({text: 'wat', user: user._id}))
                .then(doc => comment = doc)
                .then(() => comment.patches.find({ref: comment.id}))
                .then(docs => patches = docs)
                .then(() => done())
                .catch(done);
        });
        it('should create patch document', () => assert.equal(patches.length, 1));
        it('should have patch with correct data', () => assert.deepEqual(patches[0].ops.toObject(), [{
            value: 'wat',
            path: '/text',
            op: 'add'
        }]));
    });
    describe('new document saved in another db', () => {
        let post, patches;
        before(done => {
            Post2.create({title: 'foo2'})
                .then(doc => post = doc)
                .then(post => post.patches.find({ref: post.id}))
                .then(docs => patches = docs)
                .then(() => done())
                .catch(done);
        });
        it('should create patch document', () => assert.equal(patches.length, 1));
        it('should have patch with correct data', () => assert.deepEqual(patches[0].ops.toObject(), [{
                value: 'foo2',
                path: '/title',
                op: 'add'
            }]
        ))
    });
    describe('new document saved in another db (with referenced user)', () => {
        let comment, user, patches;
        before(done => {
            User2.findOne()
                .then(doc => user = doc)
                .then(() => Comment2.create({text: 'wat2', user: user._id}))
                .then(doc => comment = doc)
                .then(() => comment.patches.find({ref: comment.id}))
                .then(docs => patches = docs)
                .then(() => done())
                .catch(done);
        });
        it('should create patch document', () => assert.equal(patches.length, 1));
        it('should have patch with correct data', () => assert.deepEqual(patches[0].ops.toObject(), [{
            value: 'wat2',
            path: '/text',
            op: 'add'
        }]));
    });

    describe('updating an existing document', () => {
        it('should add a patch when document changed', (done) => {
            Post.findOne({title: 'foo'})
                .then((post) => post.set({title: 'bar'}).save())
                .then((post) => post.patches.find({ref: post.id}).sort({_id: 1}))
                .then((patches) => {
                    assert.equal(patches.length, 2);
                    assert.deepEqual(patches[1].ops.toObject(), [
                        {value: 'bar', path: '/title', op: 'replace'}
                    ])
                }).then(done).catch(done)
        });

        it('should not add a patch when document saved without changes', (done) => {
            Post.findOne({title: 'bar'})
                .then(post => post.save())
                .then((post) => post.patches.find({ref: post.id}).sort({_id: 1}))
                .then((patches) => {
                    assert.equal(patches.length, 2);
                    assert.deepEqual(patches.map(patch => patch.ops.toObject()), [
                        [{value: 'foo', path: '/title', op: 'add'}],
                        [{value: 'bar', path: '/title', op: 'replace'}]
                    ])
                }).then(done).catch(done)
        })
    });

    describe('removing a document', () => {
        it('should removes all patches', done => {
            Post.findOne({title: 'bar'})
                .then(post => post.remove())
                .then(post => post.patches.find({ref: post.id}))
                .then(patches => {
                    assert.equal(patches.length, 0)
                }).then(done).catch(done)
        });
        it('should\'t remove patches when `removePatches` is false', done => {
            Comment.findOne({text: 'wat'})
                .then(comment => comment.remove())
                .then(comment => comment.patches.find({ref: comment.id}))
                .then(patches => {
                    assert.equal(patches.length, 1)
                }).then(done).catch(done)
        })
    });

    describe('rollback', () => {
        it('should produce RollbackError in case of error', done => {
            Post.create({title: 'RollbackError test'})
                .then(post => post.rollback(ObjectId()))
                .then(done)
                .catch(err => {
                    assert(err instanceof RollbackError);
                    done()
                })
                .catch(done);
        });
        it('should reject if patch not exists', done => {
            Post.create({title: 'version 1'})
                .then(post => post.rollback(ObjectId()))
                .then(done)
                .catch(err => done());
        });

        it('to latest patch should be rejected ', done => {
            Post.create({title: 'version 1'})
                .then(post => Promise.all([post, post.patches.findOne({ref: post.id})]))
                .then(([post, latestPatch]) => {
                    return post.rollback(latestPatch.id)
                        .then(done)
                        .catch(err => {
                            assert(err instanceof RollbackError);
                            done()
                        })
                        .catch(done)
                })
        });

        it('should revert document to earlier state', done => {
            Post.create({title: 'version 1'})
                .then(doc => doc.set({title: 'version 2'}).save())
                .then(doc => doc.set({title: 'version 3'}).save())
                .then(doc => Promise.all([doc, doc.patches.findOne({ref: doc._id, 'ops.value': 'version 2'})]))
                .then(([post, patch]) => post.rollback(patch.id))
                .then(doc => assert.equal(doc.title, 'version 2'))
                .then(done).catch(done)
        });

        it('should revert document to earlier state (second db)', done => {
            Post2.create({title: 'version 1'})
                .then(doc => doc.set({title: 'version 2'}).save())
                .then(doc => doc.set({title: 'version 3'}).save())
                .then(doc => Promise.all([doc, doc.patches.findOne({ref: doc._id, 'ops.value': 'version 2'})]))
                .then(([post, patch]) => post.rollback(patch.id))
                .then(doc => assert.equal(doc.title, 'version 2'))
                .then(done).catch(done)
        });

        it('should add a new patch and update the document', (done) => {
            Comment.create({text: 'comm 1', user: ObjectId()})
                .then((c) => Comment.findOne({_id: c.id}))
                .then((c) => c.set({text: 'comm 2', user: ObjectId()}).save())
                .then((c) => Comment.findOne({_id: c.id}))
                .then((c) => c.set({text: 'comm 3', user: ObjectId()}).save())
                .then((c) => Comment.findOne({_id: c.id}))
                .then((c) => Promise.all([c, c.patches.find({ref: c.id})]))
                .then(([c, patches]) => c.rollback(patches[1].id, {user: ObjectId()}))
                .then((c) => {
                    assert.equal(c.text, 'comm 2');
                    return c.patches.find({ref: c.id})
                })
                .then(patches => assert.equal(patches.length, 4))
                .then(done).catch(done)
        })
    });
});
