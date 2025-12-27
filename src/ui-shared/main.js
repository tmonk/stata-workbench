// Shared UI Logic for Stata Extension

window.stataUI = {
    escapeHtml: function (text) {
        return (text || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    },

    formatDuration: function (ms) {
        if (ms === null || ms === undefined) return '';
        if (ms < 1000) return ms + ' ms';
        const s = ms / 1000;
        if (s < 60) return s.toFixed(1) + ' s';
        const m = Math.floor(s / 60);
        const rem = s - m * 60;
        return `${m}m ${rem.toFixed(0)}s`;
    },

    formatTimestamp: function (ts) {
        const d = new Date(ts);
        if (Number.isNaN(d.getTime())) return '';
        return d.toLocaleString(undefined, { hour: 'numeric', minute: 'numeric', second: 'numeric' });
    },

    // Common setup for artifact buttons
    bindArtifactEvents: function (vscode) {
        document.addEventListener('click', (e) => {
            const target = e.target.closest('[data-action="open-artifact"]');
            if (target) {
                const path = target.getAttribute('data-path');
                const baseDir = target.getAttribute('data-basedir');
                const label = target.getAttribute('data-label');
                if (path) {
                    vscode.postMessage({
                        type: 'openArtifact', // unified message type
                        path,
                        baseDir,
                        label
                    });
                }
            }
        });
    },

    /**
     * Regex-based Stata Syntax Highlighter
     * Derived from stata.json grammar
     */
    StataHighlighter: class {
        static patterns = [
            { name: 'prompt', regex: /^\s*\.\s+/g },
            { name: 'comment', regex: /(\/\*[\s\S]*?\*\/|\/\/.*|^\s*\*.*)/g },
            { name: 'string', regex: /(`".*?"'|(?<!`)"[^"]*")/g },
            { name: 'macro', regex: /(`\w+'|\$\w+|\$\{\w+\})/g },
            { name: 'keyword', regex: /\b(abbrev|abs|acos|acosh|adoupdate|anova|append|args|as|asin|asinh|assert|atan|atan2|atanh|autocode|bar|betaden|binomial|binomialp|binomialtail|binormalbofd|bootstrap|box|break|browse|br|byteorder|by|bysort|bys|c|capture|cap|cast|cauchy|cauchyden|cauchytail|cd|Cdhms|ceil|char|chi2|chi2den|chi2tail|Chms|cholesky|chop|clear|clip|clock|Clock|cloglog|Cmdyhms|codebook|cofC|Cofc|cofd|Cofd|coleqnumb|collatorlocale|collatorversion|colnfreeparms|colnumb|colsof|collapse|comb|compress|cond|continue|contract|copy|corr|cos|cosh|count|daily|datasignature|datasig|date|day|det|describe|des|dgammapda|dgammapdada|dgammapdadx|dgammapdx|dgammapdxdx|dhms|diag|diag0cnt|digamma|dir|discard|display|di|distinct|dofb|dofc|dofC|dofh|dofm|dofq|dofw|dofy|dow|doy|doedit|do|drop|duplicates|dups|dunnettprob|e|edit|else|el|end|epsdouble|epsfloat|erase|ereturn|eret|estimates|est|exit|expand|expandcl|exp|exponential|exponentialden|exponentialtail|export|F|Fden|fileexists|fileread|filereaderror|filewrite|file|fillin|findit|float|floor|fmtwidth|foreach|forvalues|format|fp|Ftail|gammaden|gammap|gammaptail|generate|gen|get|global|glo|graph|hadamard|halfyear|halfyearly|help|hh|hhC|hms|hist|hofd|hours|hypergeometric|hypergeometricp|I|ibeta|ibetatail|if|igaussian|igaussianden|igaussiantail|import|indexnot|infix|inlist|inrange|insheet|inspect|int|inv|invbinomial|invbinomialtail|invcauchy|invcauchytail|invchi2|invchi2tail|invcloglog|invdunnettprob|invexponential|invexponentialtail|invF|invFtail|invgammap|invgammaptail|invibeta|invibetatail|invigaussian|invigaussiantail|invlaplace|invlaplacetail|invlogistic|invlogistictail|invlogit|invnbinomial|invnbinomialtail|invnchi2|invnchi2tail|invnF|invnFtail|invnibeta|invnormal|invnt|invnttail|invpoisson|invpoissontail|invsym|invt|invttail|invtukeyprob|invweibull|invweibullph|invweibullphtail|invweibulltail|irecode|issymmetric|itrim|J|java|jdk|jdbc|joinby|keep|label|lab|labelbook|labelanguage|laplace|laplaceden|laplacetail|length|line|list|ln|lncauchyden|lnfactorial|lngamma|lnigammaden|lnigaussianden|lniwishartden|lnlaplaceden|lnmvnormalden|lnnormal|lnnormalden|lnwishartden|local|loc|log|log10|logistic|logisticden|logistictail|logit|lower|ls|ltrim|macro|matmissing|matuniform|matrix|mat|mata|max|maxbyte|maxdouble|maxfloat|maxint|maxlong|mdy|mdyhms|merge|mfp|mi|min|minbyte|mindouble|minfloat|minint|minlong|minutes|missing|mkdir|mm|mmC|mod|mofd|month|monthly|more|move|mreldif|msofhours|msofminutes|msofseconds|nbetaden|nbinomial|nbinomialp|nbinomialtail|nchi2|nchi2den|nchi2tail|nestreg|net|nF|nFden|nFtail|nibeta|noisily|noi|normal|normalden|notes|npnchi2|npnF|npnt|nt|ntden|nttail|nullmat|odbc|order|outsheet|pause|permute|plural|poisson|poissonp|poissontail|postfile|post|postclose|predict|program|define|proper|probit|python|qofd|quarter|quarterly|quietly|qui|r|rbeta|rbinomial|rcauchy|rchi2|real|recode|recast|regexs|reldif|rename|ren|replace|replay|reshape|return|ret|reverse|rexponential|rgamma|rhypergeometric|rigaussian|rlaplace|rlogistic|rmdir|rnbinomial|rnormal|rolling|round|roweqnumb|rownfreeparms|rownumb|rowsof|rpoisson|rt|rtrim|runiform|runiformint|run|rweibull|rweibullph|s|save|scalar|scatter|search|seconds|separate|set|sign|simulate|sin|sinh|sleep|smallestdouble|sort|soundex|sqrt|sreturn|sret|ss|ssC|ssc|stack|statsby|stepwise|string|stritrim|strlen|strlower|strltrim|strmatch|strofreal|strpos|strproper|strreverse|strrpos|strrtrim|strtoname|strtrim|strupper|subinstr|subinword|substr|sum|summarize|summarise|svy|sweep|sysuse|t|tabulate|tab|tab1|tab2|table|tan|tanh|tc|tC|td|tden|tempvar|tempname|tempfile|test|th|tin|tm|tobytes|tokenize|tq|trace|trigamma|trim|trunc|ttail|tukeyprob|twoway|tw|twithin|type|uchar|udstrlen|udsubstr|uisdigit|uisletter|update|upper|use|ustrcompare|ustrcompareex|ustrfix|ustrfrom|ustrinvalidcnt|ustrleft|ustrlen|ustrlower|ustrltrim|ustrnormalize|ustrpos|ustrregexs|ustrreverse|ustrright|ustrrpos|ustrrtrim|ustrsortkey|ustrsortkeyex|ustrtitle|ustrto|ustrtohex|ustrtoname|ustrtrim|ustrunescape|ustrupper|ustrword|ustrwordcount|usubinstr|usubstr|vec|vecdiag|version|webuse|week|weekly|weibull|weibullden|weibullph|weibullphden|weibullphtail|weibulltail|while|wofd|word|wordbreaklocale|wordcount|xi|xmlsave|xmluse|xpose|year|yearly|yh|ym|yofd|yq|yw)\b/g },
            { name: 'function', regex: /\b(abbrev|abs|acos|acosh|asin|asinh|atan|atan2|atanh|autocode|betaden|binomial|binomialp|binomialtail|binormalbofd|byteorder|c|cauchy|cauchyden|cauchytail|Cdhms|ceil|char|chi2|chi2den|chi2tail|Chms|cholesky|chop|clip|clock|Clock|cloglog|Cmdyhms|cofC|Cofc|cofd|Cofd|coleqnumb|collatorlocale|collatorversion|colnfreeparms|colnumb|colsof|comb|cond|corr|cos|cosh|daily|date|day|det|dgammapda|dgammapdada|dgammapdadx|dgammapdx|dgammapdxdx|dhms|diag|diag0cnt|digamma|dofb|dofc|dofC|dofh|dofm|dofq|dofw|dofy|dow|doy|dunnettprob|e|el|epsdouble|epsfloat|exp|exponential|exponentialden|exponentialtail|F|Fden|fileexists|fileread|filereaderror|filewrite|float|floor|fmtwidth|Ftail|gammaden|gammap|gammaptail|get|hadamard|halfyear|halfyearly|hh|hhC|hms|hofd|hours|hypergeometric|hypergeometricp|I|ibeta|ibetatail|igaussian|igaussianden|igaussiantail|indexnot|inlist|inrange|int|inv|invbinomial|invbinomialtail|invcauchy|invcauchytail|invchi2|invchi2tail|invcloglog|invdunnettprob|invexponential|invexponentialtail|invF|invFtail|invgammap|invgammaptail|invibeta|invibetatail|invigaussian|invigaussiantail|invlaplace|invlaplacetail|invlogistic|invlogistictail|invlogit|invnbinomial|invnbinomialtail|invnchi2|invnchi2tail|invnF|invnFtail|invnibeta|invnormal|invnt|invnttail|invpoisson|invpoissontail|invsym|invt|invttail|invtukeyprob|invweibull|invweibullph|invweibullphtail|invweibulltail|irecode|issymmetric|itrim|J|laplace|laplaceden|laplacetail|length|ln|lncauchyden|lnfactorial|lngamma|lnigammaden|lnigaussianden|lniwishartden|lnlaplaceden|lnmvnormalden|lnnormal|lnnormalden|lnwishartden|log|log10|logistic|logisticden|logistictail|logit|lower|ltrim|matmissing|matrix|matuniform|max|maxbyte|maxdouble|maxfloat|maxint|maxlong|mdy|mdyhms|mi|min|minbyte|mindouble|minfloat|minint|minlong|minutes|missing|mm|mmC|mod|mofd|month|monthly|mreldif|msofhours|msofminutes|msofseconds|nbetaden|nbinomial|nbinomialp|nbinomialtail|nchi2|nchi2den|nchi2tail|nF|nFden|nFtail|nibeta|normal|normalden|npnchi2|npnF|npnt|nt|ntden|nttail|nullmat|plural|poisson|poissonp|poissontail|proper|qofd|quarter|quarterly|r|rbeta|rbinomial|rcauchy|rchi2|real|recode|regexs|reldif|replay|return|reverse|rexponential|rgamma|rhypergeometric|rigaussian|rlaplace|rlogistic|rnbinomial|rnormal|round|roweqnumb|rownfreeparms|rownumb|rowsof|rpoisson|rt|rtrim|runiform|runiformint|rweibull|rweibullph|s|scalar|seconds|sign|sin|sinh|smallestdouble|soundex|sqrt|ss|ssC|string|stritrim|strlen|strlower|strltrim|strmatch|strofreal|strpos|strproper|strreverse|strrpos|strrtrim|strtoname|strtrim|strupper|subinstr|subinword|substr|sum|sweep|t|tan|tanh|tc|tC|td|tden|th|tin|tm|tobytes|tq|trace|trigamma|trim|trunc|ttail|tukeyprob|tw|twithin|uchar|udstrlen|udsubstr|uisdigit|uisletter|upper|ustrcompare|ustrcompareex|ustrfix|ustrfrom|ustrinvalidcnt|ustrleft|ustrlen|ustrlower|ustrltrim|ustrnormalize|ustrpos|ustrregexs|ustrreverse|ustrright|ustrrpos|ustrrtrim|ustrsortkey|ustrsortkeyex|ustrtitle|ustrto|ustrtohex|ustrtoname|ustrtrim|ustrunescape|ustrupper|ustrword|ustrwordcount|usubinstr|usubstr|vec|vecdiag|week|weekly|weibull|weibullden|weibullph|weibullphden|weibullphtail|weibulltail|wofd|word|wordbreaklocale|wordcount|year|yearly|yh|ym|yofd|yq|yw)\b(?=\()/g },
            { name: 'operator', regex: /(!|==|>=|<=|<|>|!=|\+|-|\*|\/|\^|&|\||(?<!%)%)/g },
            { name: 'constant', regex: /\b(\d+(\.\d+)?([eE][-+]?\d+)?)\b/g }
        ];

        static highlight(code) {
            if (!code) return '';

            // This is a simple one-pass highlighter
            // For production quality, we should use a proper tokenizer
            let tokens = [{ type: 'text', value: code }];

            for (const pattern of this.patterns) {
                let newTokens = [];
                for (const token of tokens) {
                    if (token.type !== 'text') {
                        newTokens.push(token);
                        continue;
                    }

                    let lastIndex = 0;
                    let match;
                    // Reset regex lastIndex because of 'g' flag
                    pattern.regex.lastIndex = 0;

                    while ((match = pattern.regex.exec(token.value)) !== null) {
                        if (match.index > lastIndex) {
                            newTokens.push({ type: 'text', value: token.value.substring(lastIndex, match.index) });
                        }
                        newTokens.push({ type: pattern.name, value: match[0] });
                        lastIndex = pattern.regex.lastIndex;
                    }

                    if (lastIndex < token.value.length) {
                        newTokens.push({ type: 'text', value: token.value.substring(lastIndex) });
                    }
                }
                tokens = newTokens;
            }

            return tokens.map(t => {
                if (t.type === 'text') return window.stataUI.escapeHtml(t.value);
                return `<span class="token-${t.type}">${window.stataUI.escapeHtml(t.value)}</span>`;
            }).join('');
        }
    }
};
