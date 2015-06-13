var argv = require('yargs').argv;
var gulp = require('gulp');
var babel = require('gulp-babel');
var browserSync = require('browser-sync').create();
var sass = require('gulp-sass');
var sourcemaps = require('gulp-sourcemaps');
var removeCode = require('gulp-remove-code');
var inject = require('gulp-inject');
var concat = require('gulp-concat');
var uglify = require('gulp-uglify');
var minifyCss = require('gulp-minify-css');
var minifyHtml = require('gulp-htmlmin');
var logSizes = require('gulp-filesize');
var gulpUtil = require('gulp-util');
var filesize = require('filesize');
var fs = require("fs");
var gzipSize = require('gzip-size');
var aws = require('aws-sdk');
var open = require('open');
var q = require('q');

// load the config
if (!fs.existsSync('config.json')) {
	throw new Error('You must first create a config.json. ' +
			'See the README and example config for more information.');
}
var config = JSON.parse(fs.readFileSync('config.json').toString());

// configure aws services
var s3 = new aws.S3({
	region: config.aws.s3.region,
	sslEnabled: true
});
var cloudFront = new aws.CloudFront({
	params: {
	  DistributionId: config.aws.cloudFront.distributionId
	}
});

// configure tasks
gulp.task('default', [
	'js',
	'sass',
	'html'
], function () {
	browserSync.init({
		server: {
			baseDir: 'build',
			index: './build/resume.html',
		},
		startPath: '/resume.html'
	});

	gulp.watch('src/*.js', ['js', browserSync.reload]);
	gulp.watch('src/*.scss', ['sass']);
	gulp.watch('src/resume.html', ['html', browserSync.reload]);
});


gulp.task('js', function () {
	return gulp.src('src/*.js')
			.pipe(sourcemaps.init())
			.pipe(babel())
			.pipe(concat('resume.js'))
			.pipe(sourcemaps.write('.'))
			.pipe(gulp.dest('build'));
});

gulp.task('sass', function () {
	return gulp.src('src/*.scss')
			.pipe(sourcemaps.init())
			.pipe(sass())
			.pipe(concat('resume.css'))
			.pipe(sourcemaps.write())
			.pipe(gulp.dest('build'))
			.pipe(browserSync.stream());
});

gulp.task('html', function () {
	return gulp.src('src/resume.html')
			.pipe(gulp.dest('build'));
});


var logStatistics = function () {
	// Print out file size compression stats!
	var jsSize = fs.statSync('build/resume.js').size;
	var cssSize = fs.statSync('build/resume.css').size;
	var htmlSize = fs.statSync('build/resume.html').size;
	var originalSize = jsSize + cssSize + htmlSize;
	var finalSize = gzipSize.sync(fs.readFileSync('dist/resume.html'));

	gulpUtil.log('JS, CSS, and HTML were ' +
			gulpUtil.colors.blue(filesize(originalSize)) + ' combined.');
	gulpUtil.log('Final HTML file size is ' +
			gulpUtil.colors.green(filesize(finalSize)) + ' gzipped (' +
			gulpUtil.colors.green(Math.round((1 - finalSize / originalSize) * 100) + '%') +
			' compression)');
}

gulp.task('dist', ['js', 'sass', 'html'], function (done) {

	var jsFileStream = gulp.src(['./build/*.js'])
			.pipe(uglify());
	var cssFileStream = gulp.src(['./build/*.css'])
			.pipe(minifyCss());

	var stream = gulp.src('build/resume.html')
			// remove all the dev build code includes
			.pipe(removeCode({production: true}))
			// embed the minified production code directly into the page
			.pipe(inject(jsFileStream, {
				starttag: '<!-- inject:js -->',
				transform: function (filePath, file) {
					// return file contents as string
					return '<script>\n(function(){' +
							file.contents.toString('utf8') +
							'}())\n</script>';
				}
			}))
			.pipe(inject(cssFileStream, {
				starttag: '<!-- inject:css -->',
				transform: function (filePath, file) {
					// return file contents as string
					return '<style>\n' + file.contents.toString('utf8') + '\n</style>';
				}
			}))
			.pipe(minifyHtml({
				collapseWhitespace: true,
				removeComments: true,
				conservativeCollapse: true
			}))
			.pipe(gulp.dest('dist'))
		
		stream.on('end', function () {
			logStatistics();
			done();
		});
});

var uploadFileToS3 = function (fileBuffer, fileName) {
	return q.ninvoke(s3, 'upload', {
		'Bucket': config.aws.s3.bucket,
		'Body': fileBuffer,
		'Key': fileName,
		'ContentType': 'text/html'
	});
};

var invalidateFileInCloudFront = function (fileName) {
	return q.ninvoke(cloudFront, 'createInvalidation', {
		InvalidationBatch: {
			// TODO: use a better value, like a hash of the file contents
			CallerReference: '' + Date.now(),
	    Paths: {
	      Quantity: 1,
	      Items: ['/resume.html']
	    }
	  }
	});
};

gulp.task('stage', ['dist'], function (done) {
	gulpUtil.log('Staging...');
	
	uploadFileToS3(fs.readFileSync('dist/resume.html'), 'staged.html')
	.then(function (data) {
		if (data && data['Location']) {
			gulpUtil.log(gulpUtil.colors.green('Staged successfully, ' +
					'opening staged page in browser...'));
			open(data['Location']);
		}
	})
	.catch(function (error) {
		gulpUtil.log(gulpUtil.colors.red('Stage failed!'), error);
	})
	.finally(done)
	.done();
});

// TODO: only allow release when the git working directory is clean, for safety
gulp.task('release', ['dist'], function (done) {
	gulpUtil.log('Releasing to production...');
	
	uploadFileToS3(fs.readFileSync('dist/resume.html'), 'resume.html')
	.then(function () {
		return invalidateFileInCloudFront('resume.html')
	})
	.then(function (data) {
		gulpUtil.log(gulpUtil.colors.green('Successfully released! ' +
				'The resume cache has been invalidated, which may take up to 15 ' +
				'minutes to take effect before this release is viewable everywhere'));
	})
	.catch(function (error) {
		gulpUtil.log(gulpUtil.colors.red('Release failed!'), error);
	})
	.finally(done)
	.done();
});