module.exports = {

    extends: ['@commitlint/config-conventional'],
    rules: {
        'body-max-line-length': [1, 'always', 500],
        'subject-case': [1, 'always', 'sentence-case'],
        'subject-full-stop': [1, 'never'],
        'header-max-length': [1, 'always', 500],
    },


};
